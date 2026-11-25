import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET_NAME = "garment-photos";
const SIGNED_URL_TTL_SECONDS = 1800; // 30 minutes
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

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

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (!isAllowedOrigin(origin)) {
    return jsonResponse({ found: false, error: "Origin tidak diizinkan." }, origin, 403);
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders(origin) });
  }

  if (req.method !== "POST") {
    return jsonResponse({ found: false, error: "Metode tidak diizinkan." }, origin, 405);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return jsonResponse({ found: false, error: "Payload tidak valid." }, origin, 400);
    }
  } catch {
    return jsonResponse({ found: false, error: "Format JSON tidak valid." }, origin, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ found: false, error: "Konfigurasi server belum lengkap." }, origin, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const action = String(payload.action || "").trim().toLowerCase();
  const slug = normalizeSlug(payload.slug);

  if (!slug) {
    return jsonResponse(
      { found: false, mode: "tenant_not_found", message: "Workshop tidak ditemukan." },
      origin
    );
  }

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .select("id, slug, name, tagline, address, admin_phone, opening_hours, logo_data_url, locale, currency, is_active")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (tenantError) {
    console.error("public-tracker tenant query failed:", tenantError.message);
    return jsonResponse({ found: false, error: "Gagal memuat data workshop." }, origin, 500);
  }

  if (!tenant) {
    return jsonResponse(
      { found: false, mode: "tenant_not_found", message: "Workshop tidak ditemukan atau tidak aktif." },
      origin
    );
  }

  if (action === "profile") {
    return jsonResponse(
      {
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
        },
      },
      origin
    );
  }

  const normalizedPhone = normalizePhone(payload.phone);
  if (normalizedPhone.length < 10) {
    return jsonResponse(
      {
        found: false,
        mode: "invalid_phone",
        message: "Masukkan nomor WhatsApp terdaftar minimal 10 digit.",
      },
      origin
    );
  }

  if (action === "lookup") {
    const { data: orders, error: ordersError } = await supabaseAdmin
      .from("orders")
      .select("id, ticket_code, status, estimated_done_date, created_at, order_items(id)")
      .eq("tenant_id", tenant.id)
      .eq("customer_phone", normalizedPhone)
      .order("created_at", { ascending: false });

    if (ordersError) {
      console.error("public-tracker lookup failed:", ordersError.message);
      return jsonResponse({ found: false, error: "Gagal mencari daftar order." }, origin, 500);
    }

    if (!orders || orders.length === 0) {
      return jsonResponse(
        {
          found: false,
          mode: "not_found",
          message: "Order tidak ditemukan. Periksa kembali nomor WhatsApp Anda.",
        },
        origin
      );
    }

    const tickets = orders.map((order) => ({
      ticket_code: order.ticket_code,
      status: order.status,
      estimated_done_date: order.estimated_done_date,
      created_at: order.created_at,
      item_count: Array.isArray(order.order_items) ? order.order_items.length : 0,
    }));

    return jsonResponse({ found: true, mode: "list", tickets }, origin);
  }

  if (action === "detail") {
    const ticketCode = String(payload.ticket_code || "").trim().toUpperCase();
    if (!ticketCode) {
      return jsonResponse(
        { found: false, mode: "not_found", message: "Kode tiket wajib diisi." },
        origin
      );
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .select(
        "id, ticket_code, customer_name, status, total_amount, paid_amount, payment_status, estimated_done_date, notes, created_at, updated_at"
      )
      .eq("tenant_id", tenant.id)
      .eq("customer_phone", normalizedPhone)
      .eq("ticket_code", ticketCode)
      .maybeSingle();

    if (orderError) {
      console.error("public-tracker detail order failed:", orderError.message);
      return jsonResponse({ found: false, error: "Gagal memuat detail order." }, origin, 500);
    }

    if (!order) {
      return jsonResponse(
        {
          found: false,
          mode: "not_found",
          message: "Order tidak ditemukan untuk kombinasi nomor WhatsApp dan kode tiket tersebut.",
        },
        origin
      );
    }

    const [itemsResult, logsResult] = await Promise.all([
      supabaseAdmin
        .from("order_items")
        .select("id, garment_name, service_type, measurement_specs, price, before_photo_path, after_photo_path")
        .eq("tenant_id", tenant.id)
        .eq("order_id", order.id)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("order_logs")
        .select("id, status, log_note, created_at")
        .eq("tenant_id", tenant.id)
        .eq("order_id", order.id)
        .order("created_at", { ascending: true }),
    ]);

    if (itemsResult.error || logsResult.error) {
      console.error(
        "public-tracker detail items/logs failed:",
        itemsResult.error?.message || logsResult.error?.message
      );
      return jsonResponse({ found: false, error: "Gagal memuat rincian order." }, origin, 500);
    }

    const rawItems = itemsResult.data || [];
    const expectedPrefix = `${tenant.id}/${order.id}/`;
    const photoPathsToSign = Array.from(
      new Set(
        rawItems
          .flatMap((it) => [it.before_photo_path, it.after_photo_path])
          .filter((p): p is string => typeof p === "string" && p.startsWith(expectedPrefix))
      )
    );

    const signedUrlMap = new Map<string, string>();
    if (photoPathsToSign.length > 0) {
      const { data: signedList, error: signError } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .createSignedUrls(photoPathsToSign, SIGNED_URL_TTL_SECONDS);

      if (signError) {
        console.error("public-tracker signed URL generation failed:", signError.message);
      } else if (Array.isArray(signedList)) {
        for (const entry of signedList) {
          if (entry.path && entry.signedUrl) {
            signedUrlMap.set(entry.path, entry.signedUrl);
          }
        }
      }
    }

    const items = rawItems.map((it) => ({
      id: it.id,
      garment_name: it.garment_name,
      service_type: it.service_type,
      measurement_specs: it.measurement_specs || {},
      price: it.price,
      before_photo_url:
        it.before_photo_path && it.before_photo_path.startsWith(expectedPrefix)
          ? signedUrlMap.get(it.before_photo_path) || null
          : null,
      after_photo_url:
        it.after_photo_path && it.after_photo_path.startsWith(expectedPrefix)
          ? signedUrlMap.get(it.after_photo_path) || null
          : null,
    }));

    return jsonResponse(
      {
        found: true,
        mode: "detail",
        order: {
          ticket_code: order.ticket_code,
          customer_name: order.customer_name,
          status: order.status,
          total_amount: order.total_amount,
          paid_amount: order.paid_amount,
          payment_status: order.payment_status,
          estimated_done_date: order.estimated_done_date,
          notes: order.notes,
          created_at: order.created_at,
          updated_at: order.updated_at,
        },
        items,
        logs: logsResult.data || [],
      },
      origin
    );
  }

  return jsonResponse({ found: false, error: "Aksi tidak dikenal." }, origin, 400);
});
