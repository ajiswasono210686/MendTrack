import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET_NAME = "garment-photos";
const SIGNED_URL_TTL_SECONDS = 1800; // 30 minutes
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_PINS = 10;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_MAX_PER_PHONE = 5;
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const TOKEN_REGEX = /^[a-f0-9]{32,128}$/i;

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  const extraOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (extraOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    ) {
      return true;
    }
    if (url.protocol === "https:" && url.hostname.endsWith(".vercel.app")) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(body: unknown, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}

function normalizeSlug(raw: unknown): string {
  const slug = String(raw || "").trim().toLowerCase();
  return SLUG_REGEX.test(slug) ? slug : "";
}

function normalizePhone(raw: unknown): string {
  let digits = String(raw || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("0")) {
    digits = "62" + digits.slice(1);
  } else if (digits.startsWith("8")) {
    digits = "62" + digits;
  }
  return digits;
}

function detectImageType(bytes: Uint8Array): { ext: string; mime: string } | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { ext: "png", mime: "image/png" };
  }
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

function generateSecureHex(byteLength = 24): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function formatQuoteCode(seq: number): string {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `QT-${yy}${mm}-${String(seq).padStart(3, "0")}`;
}

interface DamagePin {
  id: number;
  x: number;
  y: number;
  note: string;
}

function parseDamagePins(raw: unknown): { ok: true; pins: DamagePin[] } | { ok: false; mode: string; error: string } {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, mode: "invalid_pins", error: "Format pin kerusakan tidak valid." };
  }

  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_PINS) {
    return {
      ok: false,
      mode: "invalid_pins",
      error: `Tandai 1 hingga ${MAX_PINS} titik kerusakan pada foto.`,
    };
  }

  const pins: DamagePin[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") {
      return { ok: false, mode: "invalid_pins", error: "Data pin kerusakan tidak valid." };
    }
    const x = Number(entry.x);
    const y = Number(entry.y);
    const note = String(entry.note || "").trim();
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
      return { ok: false, mode: "invalid_pins", error: "Koordinat pin harus berada di antara 0 dan 100." };
    }
    if (!note || note.length > 240) {
      return {
        ok: false,
        mode: "invalid_pin_note",
        error: "Setiap pin wajib memiliki catatan singkat maksimal 240 karakter.",
      };
    }
    pins.push({
      id: i + 1,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      note,
    });
  }

  return { ok: true, pins };
}

function getExtensionFromPath(path: string): string {
  const lower = String(path || "").toLowerCase();
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".webp")) return "webp";
  return "jpg";
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (!isAllowedOrigin(origin)) {
    return jsonResponse({ ok: false, found: false, error: "Origin tidak diizinkan." }, origin, 403);
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders(origin) });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, found: false, error: "Metode tidak diizinkan." }, origin, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, found: false, error: "Konfigurasi server belum lengkap." }, origin, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const contentType = (req.headers.get("content-type") || "").toLowerCase();

  // A. Multipart visual intake submission (action = "submit")
  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return jsonResponse({ ok: false, mode: "invalid_payload", error: "Gagal membaca data formulir." }, origin, 400);
    }

    // Silent bot trap
    const honeypot = String(formData.get("website") || "").trim();
    if (honeypot.length > 0) {
      return jsonResponse({ ok: false, mode: "blocked", error: "Permintaan ditolak." }, origin, 400);
    }

    const slug = normalizeSlug(formData.get("slug"));
    if (!slug) {
      return jsonResponse({ ok: false, mode: "tenant_not_found", error: "Workshop tidak ditemukan." }, origin, 404);
    }

    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from("tenants")
      .select("id, slug, name, is_active")
      .eq("slug", slug)
      .eq("is_active", true)
      .maybeSingle();

    if (tenantError) {
      console.error("public-quote submit tenant lookup failed:", tenantError.message);
      return jsonResponse({ ok: false, error: "Gagal memuat workshop." }, origin, 500);
    }
    if (!tenant) {
      return jsonResponse({ ok: false, mode: "tenant_not_found", error: "Workshop tidak ditemukan atau tidak aktif." }, origin, 404);
    }

    const customerName = String(formData.get("customer_name") || "").trim().slice(0, 120);
    const customerPhone = normalizePhone(formData.get("customer_phone"));
    const orderTypeRaw = String(formData.get("order_type") || "walk_in").trim().toLowerCase();
    const orderType = orderTypeRaw === "mail_in" ? "mail_in" : "walk_in";
    const garmentName = String(formData.get("garment_name") || "").trim().slice(0, 160);
    const requestedService = String(formData.get("requested_service") || "").trim().slice(0, 160) || null;
    const customerNotes = String(formData.get("customer_notes") || "").trim().slice(0, 1000) || null;

    if (!customerName) {
      return jsonResponse({ ok: false, mode: "invalid_fields", error: "Nama lengkap wajib diisi." }, origin, 400);
    }
    if (customerPhone.length < 10) {
      return jsonResponse({ ok: false, mode: "invalid_phone", error: "Nomor WhatsApp minimal 10 digit." }, origin, 400);
    }
    if (!garmentName) {
      return jsonResponse({ ok: false, mode: "invalid_fields", error: "Nama atau deskripsi pakaian wajib diisi." }, origin, 400);
    }

    const pinsResult = parseDamagePins(formData.get("damage_pins"));
    if (!pinsResult.ok) {
      return jsonResponse({ ok: false, mode: pinsResult.mode, error: pinsResult.error }, origin, 400);
    }

    const photoField = formData.get("photo");
    if (!(photoField instanceof File)) {
      return jsonResponse({ ok: false, mode: "missing_photo", error: "Foto pakaian wajib diunggah." }, origin, 400);
    }
    if (photoField.size <= 0 || photoField.size > MAX_UPLOAD_BYTES) {
      return jsonResponse({ ok: false, mode: "photo_too_large", error: "Ukuran foto maksimal 5 MB." }, origin, 400);
    }

    const photoBytes = new Uint8Array(await photoField.arrayBuffer());
    const detectedImage = detectImageType(photoBytes);
    if (!detectedImage) {
      return jsonResponse(
        { ok: false, mode: "invalid_photo_type", error: "Format foto tidak valid. Gunakan JPG, PNG, atau WebP." },
        origin,
        400
      );
    }

    // Rolling 24-hour rate limit per (tenant, customer_phone).
    const cutoffIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const { count: recentCount, error: rateError } = await supabaseAdmin
      .from("quote_requests")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("customer_phone", customerPhone)
      .gte("created_at", cutoffIso);

    if (rateError) {
      console.error("public-quote rate limit query failed:", rateError.message);
      return jsonResponse({ ok: false, error: "Gagal memeriksa batas pengajuan." }, origin, 500);
    }
    if ((recentCount || 0) >= RATE_LIMIT_MAX_PER_PHONE) {
      return jsonResponse(
        {
          ok: false,
          mode: "rate_limited",
          error: "Batas pengajuan estimasi harian untuk nomor ini telah tercapai. Hubungi workshop via WhatsApp.",
        },
        origin,
        429
      );
    }

    const quoteId = crypto.randomUUID();
    const approvalToken = generateSecureHex(24);
    const randSuffix = generateSecureHex(4);
    const intakePhotoPath = `${tenant.id}/quotes/${quoteId}/intake_${Date.now()}_${randSuffix}.${detectedImage.ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET_NAME)
      .upload(intakePhotoPath, photoBytes, {
        contentType: detectedImage.mime,
        upsert: false,
      });

    if (uploadError) {
      console.error("public-quote storage upload failed:", uploadError.message);
      return jsonResponse({ ok: false, error: "Gagal mengunggah foto pakaian." }, origin, 500);
    }

    // Compute a readable quote code with collision retry.
    const { count: monthCount } = await supabaseAdmin
      .from("quote_requests")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id);

    let seq = (monthCount || 0) + 1;
    let insertedCode = "";
    let insertErr: { message?: string; code?: string } | null = null;

    for (let attempt = 0; attempt < 6; attempt++) {
      const candidateCode = formatQuoteCode(seq + attempt);
      const { data: inserted, error: err } = await supabaseAdmin
        .from("quote_requests")
        .insert({
          id: quoteId,
          tenant_id: tenant.id,
          quote_code: candidateCode,
          approval_token: approvalToken,
          status: "new",
          customer_name: customerName,
          customer_phone: customerPhone,
          order_type: orderType,
          garment_name: garmentName,
          requested_service: requestedService,
          customer_notes: customerNotes,
          intake_photo_path: intakePhotoPath,
          damage_pins: pinsResult.pins,
        })
        .select("quote_code")
        .single();

      if (!err && inserted) {
        insertedCode = inserted.quote_code;
        insertErr = null;
        break;
      }
      insertErr = err;
      if (err?.code !== "23505") break;
    }

    if (insertErr || !insertedCode) {
      console.error("public-quote db insert failed:", insertErr?.message);
      await supabaseAdmin.storage.from(BUCKET_NAME).remove([intakePhotoPath]).catch(() => {});
      return jsonResponse({ ok: false, error: "Gagal menyimpan permintaan estimasi." }, origin, 500);
    }

    return jsonResponse(
      {
        ok: true,
        quote_code: insertedCode,
        status: "new",
        store_name: tenant.name,
      },
      origin,
      200
    );
  }

  // B. JSON actions ("detail", "approve", "decline")
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return jsonResponse({ ok: false, found: false, error: "Payload tidak valid." }, origin, 400);
    }
  } catch {
    return jsonResponse({ ok: false, found: false, error: "Format JSON tidak valid." }, origin, 400);
  }

  const action = String(payload.action || "").trim().toLowerCase();
  const slug = normalizeSlug(payload.slug);
  const token = String(payload.token || "").trim();

  if (!slug) {
    return jsonResponse({ ok: false, found: false, mode: "tenant_not_found", error: "Workshop tidak ditemukan." }, origin);
  }
  if (!TOKEN_REGEX.test(token)) {
    return jsonResponse({ ok: false, found: false, mode: "quote_not_found", error: "Tautan quote tidak valid." }, origin);
  }

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("id, slug, name, tagline, address, admin_phone, opening_hours, logo_data_url, locale, currency, timezone, is_active")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (tenantError) {
    console.error("public-quote tenant lookup failed:", tenantError.message);
    return jsonResponse({ ok: false, found: false, error: "Gagal memuat workshop." }, origin, 500);
  }
  if (!tenant) {
    return jsonResponse({ ok: false, found: false, mode: "tenant_not_found", error: "Workshop tidak ditemukan atau tidak aktif." }, origin);
  }

  const { data: quote, error: quoteError } = await supabaseAdmin
    .from("quote_requests")
    .select(
      "id, tenant_id, quote_code, status, customer_name, customer_phone, order_type, garment_name, requested_service, customer_notes, intake_photo_path, damage_pins, quoted_items, quoted_total, estimated_days, estimated_done_date, workshop_notes, customer_decision_note, quoted_at, decided_at, converted_order_id, created_at"
    )
    .eq("tenant_id", tenant.id)
    .eq("approval_token", token)
    .maybeSingle();

  if (quoteError) {
    console.error("public-quote detail query failed:", quoteError.message);
    return jsonResponse({ ok: false, found: false, error: "Gagal memuat detail estimasi." }, origin, 500);
  }
  if (!quote) {
    return jsonResponse({ ok: false, found: false, mode: "quote_not_found", error: "Estimasi tidak ditemukan." }, origin);
  }

  if (action === "detail") {
    const expectedPrefix = `${tenant.id}/quotes/${quote.id}/`;
    let signedPhotoUrl: string | null = null;
    if (typeof quote.intake_photo_path === "string" && quote.intake_photo_path.startsWith(expectedPrefix)) {
      const { data: signedData, error: signError } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .createSignedUrl(quote.intake_photo_path, SIGNED_URL_TTL_SECONDS);
      if (!signError && signedData?.signedUrl) {
        signedPhotoUrl = signedData.signedUrl;
      }
    }

    let convertedOrder: { ticket_code: string; status: string; order_type: string } | null = null;
    if (quote.converted_order_id) {
      const { data: ord } = await supabaseAdmin
        .from("orders")
        .select("ticket_code, status, order_type")
        .eq("tenant_id", tenant.id)
        .eq("id", quote.converted_order_id)
        .maybeSingle();
      if (ord) {
        convertedOrder = {
          ticket_code: ord.ticket_code,
          status: ord.status,
          order_type: ord.order_type || quote.order_type || "walk_in",
        };
      }
    }

    return jsonResponse(
      {
        ok: true,
        found: true,
        store: {
          slug: tenant.slug,
          name: tenant.name,
          tagline: tenant.tagline || "",
          address: tenant.address || "",
          admin_phone: tenant.admin_phone || "",
          opening_hours: tenant.opening_hours || "",
          logo_data_url: tenant.logo_data_url || "",
          locale: tenant.locale || "id",
          currency: tenant.currency || "IDR",
          timezone: tenant.timezone || "Asia/Jakarta",
        },
        quote: {
          quote_code: quote.quote_code,
          status: quote.status,
          customer_name: quote.customer_name,
          order_type: quote.order_type || "walk_in",
          garment_name: quote.garment_name,
          requested_service: quote.requested_service || "",
          customer_notes: quote.customer_notes || "",
          intake_photo_url: signedPhotoUrl,
          damage_pins: Array.isArray(quote.damage_pins) ? quote.damage_pins : [],
          quoted_items: Array.isArray(quote.quoted_items) ? quote.quoted_items : [],
          quoted_total: Number(quote.quoted_total || 0),
          estimated_days: quote.estimated_days,
          estimated_done_date: quote.estimated_done_date,
          workshop_notes: quote.workshop_notes || "",
          customer_decision_note: quote.customer_decision_note || "",
          quoted_at: quote.quoted_at,
          decided_at: quote.decided_at,
          created_at: quote.created_at,
          converted_order: convertedOrder,
        },
      },
      origin
    );
  }

  if (action === "approve") {
    // Fast idempotent path if already converted.
    if (quote.status === "approved" && quote.converted_order_id) {
      const { data: ord } = await supabaseAdmin
        .from("orders")
        .select("id, ticket_code, order_type, status")
        .eq("tenant_id", tenant.id)
        .eq("id", quote.converted_order_id)
        .maybeSingle();

      if (ord) {
        return jsonResponse(
          {
            ok: true,
            already_approved: true,
            order: {
              ticket_code: ord.ticket_code,
              order_type: ord.order_type || quote.order_type || "walk_in",
              status: ord.status,
            },
          },
          origin
        );
      }
    }

    if (quote.status !== "quoted") {
      return jsonResponse(
        {
          ok: false,
          mode: "invalid_status",
          error: "Estimasi ini belum siap disetujui atau sudah diproses sebelumnya.",
        },
        origin,
        409
      );
    }

    const newOrderId = crypto.randomUUID();
    const expectedIntakePrefix = `${tenant.id}/quotes/${quote.id}/`;
    let promotedBeforePath: string | null = null;

    if (typeof quote.intake_photo_path === "string" && quote.intake_photo_path.startsWith(expectedIntakePrefix)) {
      const ext = getExtensionFromPath(quote.intake_photo_path);
      const targetPath = `${tenant.id}/${newOrderId}/before_quote_${Date.now()}.${ext}`;
      const { error: copyError } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .copy(quote.intake_photo_path, targetPath);
      if (!copyError) {
        promotedBeforePath = targetPath;
      } else {
        console.warn("public-quote photo promotion copy warning:", copyError.message);
      }
    }

    const { data: rpcRows, error: rpcError } = await supabaseAdmin.rpc("approve_quote_to_order", {
      p_tenant_id: tenant.id,
      p_approval_token: token,
      p_new_order_id: newOrderId,
      p_before_photo_path: promotedBeforePath,
    });

    if (rpcError || !Array.isArray(rpcRows) || rpcRows.length === 0) {
      console.error("public-quote approve_quote_to_order failed:", rpcError?.message);
      if (promotedBeforePath) {
        await supabaseAdmin.storage.from(BUCKET_NAME).remove([promotedBeforePath]).catch(() => {});
      }
      return jsonResponse(
        { ok: false, mode: "approve_failed", error: rpcError?.message || "Gagal menyetujui estimasi." },
        origin,
        400
      );
    }

    const row = rpcRows[0];
    // Clean up unused promoted photo if a concurrent click won the conversion race.
    if (row.already_approved && promotedBeforePath && row.order_id !== newOrderId) {
      await supabaseAdmin.storage.from(BUCKET_NAME).remove([promotedBeforePath]).catch(() => {});
    }

    return jsonResponse(
      {
        ok: true,
        already_approved: Boolean(row.already_approved),
        order: {
          ticket_code: row.ticket_code,
          order_type: row.order_type || quote.order_type || "walk_in",
          status: row.status,
        },
      },
      origin
    );
  }

  if (action === "decline") {
    if (quote.status === "approved") {
      return jsonResponse(
        { ok: false, mode: "already_approved", error: "Estimasi yang sudah disetujui tidak dapat ditolak." },
        origin,
        409
      );
    }
    if (quote.status !== "quoted") {
      return jsonResponse(
        { ok: false, mode: "invalid_status", error: "Estimasi tidak dalam status menunggu persetujuan." },
        origin,
        409
      );
    }

    const decisionRaw = String(payload.decision || "revision_requested").trim().toLowerCase();
    const nextStatus = decisionRaw === "rejected" ? "rejected" : "revision_requested";
    const note = String(payload.note || "").trim().slice(0, 800) || null;

    const { error: updateError } = await supabaseAdmin
      .from("quote_requests")
      .update({
        status: nextStatus,
        customer_decision_note: note,
        decided_at: new Date().toISOString(),
      })
      .eq("id", quote.id)
      .eq("tenant_id", tenant.id)
      .eq("status", "quoted");

    if (updateError) {
      console.error("public-quote decline update failed:", updateError.message);
      return jsonResponse({ ok: false, error: "Gagal menyimpan keputusan Anda." }, origin, 500);
    }

    return jsonResponse({ ok: true, status: nextStatus }, origin);
  }

  return jsonResponse({ ok: false, found: false, error: "Aksi tidak dikenal." }, origin, 400);
});
