import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildOrderCompletedEmail,
  buildOrderReadyEmail,
  buildQuotePublishedEmail,
  buildTeamInviteEmail,
  buildVoucherIssuedEmail,
  getEmailEnvConfig,
  isValidEmail,
  normalizeEmail,
  normalizeLocale,
  sendResendEmailAndLog,
} from "../_shared/transactional-email.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_EVENTS = new Set([
  "team_invite",
  "quote_published",
  "order_ready",
  "order_completed",
  "voucher_issued",
]);

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

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (!isAllowedOrigin(origin)) {
    return jsonResponse({ ok: false, error: "Origin tidak diizinkan." }, origin, 403);
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders(origin) });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Metode tidak diizinkan." }, origin, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Konfigurasi server belum lengkap." }, origin, 500);
  }

  const authHeader = req.headers.get("authorization") || "";
  const tokenMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const jwt = tokenMatch ? tokenMatch[1].trim() : "";
  if (!jwt) {
    return jsonResponse({ ok: false, error: "Token autentikasi wajib disertakan." }, origin, 401);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse({ ok: false, error: "Sesi autentikasi tidak valid." }, origin, 401);
  }
  const caller = userData.user;
  if (!caller.email_confirmed_at) {
    return jsonResponse({ ok: false, error: "Email akun belum terverifikasi." }, origin, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ ok: false, error: "Payload tidak valid." }, origin, 400);
    }
  } catch {
    return jsonResponse({ ok: false, error: "Format JSON tidak valid." }, origin, 400);
  }

  const tenantId = String(body.tenant_id || "").trim();
  const eventType = String(body.event_type || "").trim();

  if (!UUID_REGEX.test(tenantId)) {
    return jsonResponse({ ok: false, error: "Tenant ID tidak valid." }, origin, 400);
  }
  if (!ALLOWED_EVENTS.has(eventType)) {
    return jsonResponse({ ok: false, error: "Jenis event email tidak didukung." }, origin, 400);
  }

  const { data: membership, error: memberErr } = await supabaseAdmin
    .from("tenant_members")
    .select("role, is_active")
    .eq("tenant_id", tenantId)
    .eq("user_id", caller.id)
    .eq("is_active", true)
    .maybeSingle();

  if (memberErr || !membership) {
    return jsonResponse({ ok: false, error: "Akses workshop ditolak." }, origin, 403);
  }

  const { data: tenant, error: tenantErr } = await supabaseAdmin
    .from("tenants")
    .select("id, slug, name, locale, currency, timezone, notification_email, admin_phone, is_active")
    .eq("id", tenantId)
    .eq("is_active", true)
    .maybeSingle();

  if (tenantErr || !tenant) {
    return jsonResponse({ ok: false, error: "Workshop tidak aktif atau tidak ditemukan." }, origin, 403);
  }

  const callerRole = String(membership.role || "").toLowerCase();
  const isStaffCaller = callerRole === "staff";
  const locale = normalizeLocale(tenant.locale);
  const currency = String(tenant.currency || "IDR").toUpperCase();
  const env = getEmailEnvConfig();

  if (eventType === "order_ready") {
    if (!["owner", "admin", "staff"].includes(callerRole)) {
      return jsonResponse({ ok: false, error: "Peran tidak diizinkan." }, origin, 403);
    }
  } else if (!["owner", "admin"].includes(callerRole)) {
    return jsonResponse({ ok: false, error: "Hanya Owner atau Admin yang dapat mengirim email ini." }, origin, 403);
  }

  if (eventType === "team_invite") {
    const invitationId = String(body.invitation_id || "").trim();
    if (!UUID_REGEX.test(invitationId)) {
      return jsonResponse({ ok: false, error: "Invitation ID tidak valid." }, origin, 400);
    }

    const { data: invite, error: inviteErr } = await supabaseAdmin
      .from("tenant_invitations")
      .select("id, email, role, token, status, expires_at")
      .eq("id", invitationId)
      .eq("tenant_id", tenant.id)
      .maybeSingle();

    if (inviteErr || !invite) {
      return jsonResponse({ ok: false, error: "Undangan tidak ditemukan." }, origin, 404);
    }
    if (callerRole === "admin" && String(invite.role || "").toLowerCase() !== "staff") {
      return jsonResponse({ ok: false, error: "Admin hanya dapat mengirim email undangan peran Staff." }, origin, 403);
    }
    if (invite.status !== "pending") {
      return jsonResponse({ ok: false, error: "Undangan tidak dalam status menunggu." }, origin, 400);
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      return jsonResponse({ ok: false, error: "Undangan sudah kedaluwarsa." }, origin, 400);
    }

    const inviteUrl = `${env.appBaseUrl}/admin?invite=${encodeURIComponent(invite.token)}`;
    const rendered = buildTeamInviteEmail({
      locale,
      workshopName: tenant.name,
      invitedRole: invite.role,
      expiresAt: invite.expires_at,
      timezone: tenant.timezone,
      inviteUrl,
    });

    const result = await sendResendEmailAndLog(supabaseAdmin, {
      tenantId: tenant.id,
      eventType: "team_invite",
      recipientEmail: invite.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      locale,
      replyTo: tenant.notification_email || null,
      relatedEntityType: "invitation",
      relatedEntityId: invite.id,
      createdBy: caller.id,
    });

    return jsonResponse(
      {
        ok: true,
        event_type: "team_invite",
        status: result.status,
        reason: result.reason || null,
        recipient_email: invite.email,
        provider_message_id: result.provider_message_id || null,
      },
      origin,
      200
    );
  }

  if (eventType === "quote_published") {
    const quoteId = String(body.quote_id || "").trim();
    if (!UUID_REGEX.test(quoteId)) {
      return jsonResponse({ ok: false, error: "Quote ID tidak valid." }, origin, 400);
    }

    const { data: quote, error: quoteErr } = await supabaseAdmin
      .from("quote_requests")
      .select(
        "id, quote_code, approval_token, status, customer_name, customer_email, garment_name, quoted_items, quoted_total, estimated_days, estimated_done_date, workshop_notes"
      )
      .eq("id", quoteId)
      .eq("tenant_id", tenant.id)
      .maybeSingle();

    if (quoteErr || !quote) {
      return jsonResponse({ ok: false, error: "Permintaan quote tidak ditemukan." }, origin, 404);
    }
    if (quote.status !== "quoted") {
      return jsonResponse({ ok: false, error: "Quote belum berstatus menunggu persetujuan." }, origin, 400);
    }

    const recipient = normalizeEmail(quote.customer_email);
    if (!recipient || !isValidEmail(recipient)) {
      return jsonResponse(
        {
          ok: true,
          event_type: "quote_published",
          status: "skipped",
          reason: "no_recipient_email",
        },
        origin,
        200
      );
    }

    const approvalUrl = `${env.appBaseUrl}/t/${encodeURIComponent(tenant.slug)}?quote=${encodeURIComponent(
      quote.approval_token
    )}`;
    const rendered = buildQuotePublishedEmail({
      locale,
      workshopName: tenant.name,
      quoteCode: quote.quote_code,
      customerName: quote.customer_name,
      garmentName: quote.garment_name,
      items: Array.isArray(quote.quoted_items) ? quote.quoted_items : [],
      total: Number(quote.quoted_total || 0),
      currency,
      estimatedDays: quote.estimated_days,
      estimatedDoneDate: quote.estimated_done_date,
      workshopNotes: quote.workshop_notes,
      approvalUrl,
    });

    const result = await sendResendEmailAndLog(supabaseAdmin, {
      tenantId: tenant.id,
      eventType: "quote_published",
      recipientEmail: recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      locale,
      replyTo: tenant.notification_email || null,
      relatedEntityType: "quote",
      relatedEntityId: quote.id,
      createdBy: caller.id,
    });

    return jsonResponse(
      {
        ok: true,
        event_type: "quote_published",
        status: result.status,
        reason: result.reason || null,
        recipient_email: recipient,
        provider_message_id: result.provider_message_id || null,
      },
      origin,
      200
    );
  }

  if (eventType === "voucher_issued") {
    const voucherId = String(body.voucher_id || "").trim();
    if (!UUID_REGEX.test(voucherId)) {
      return jsonResponse({ ok: false, error: "Voucher ID tidak valid." }, origin, 400);
    }

    const { data: voucher, error: voucherErr } = await supabaseAdmin
      .from("vouchers")
      .select("id, code, discount_type, discount_value, status, expires_at, customer_id, customer_name, customer_email, notes")
      .eq("id", voucherId)
      .eq("tenant_id", tenant.id)
      .maybeSingle();

    if (voucherErr || !voucher) {
      return jsonResponse({ ok: false, error: "Voucher tidak ditemukan." }, origin, 404);
    }

    let recipient = normalizeEmail(voucher.customer_email);
    if (!recipient && voucher.customer_id) {
      const { data: cust } = await supabaseAdmin
        .from("customers")
        .select("email")
        .eq("id", voucher.customer_id)
        .eq("tenant_id", tenant.id)
        .maybeSingle();
      recipient = normalizeEmail(cust?.email);
    }

    if (!recipient || !isValidEmail(recipient)) {
      await supabaseAdmin
        .from("vouchers")
        .update({
          email_status: "skipped",
          email_error: "No valid customer email",
          updated_at: new Date().toISOString(),
        })
        .eq("id", voucher.id)
        .eq("tenant_id", tenant.id);

      return jsonResponse(
        {
          ok: true,
          event_type: "voucher_issued",
          status: "skipped",
          reason: "no_recipient_email",
        },
        origin,
        200
      );
    }

    const trackingUrl = `${env.appBaseUrl}/t/${encodeURIComponent(tenant.slug)}`;
    const rendered = buildVoucherIssuedEmail({
      locale,
      workshopName: tenant.name,
      customerName: voucher.customer_name || "",
      voucherCode: voucher.code,
      discountType: voucher.discount_type,
      discountValue: Number(voucher.discount_value || 0),
      currency,
      expiresAt: voucher.expires_at,
      notes: voucher.notes,
      trackingUrl,
    });

    const result = await sendResendEmailAndLog(supabaseAdmin, {
      tenantId: tenant.id,
      eventType: "voucher_issued",
      recipientEmail: recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      locale,
      replyTo: tenant.notification_email || null,
      createdBy: caller.id,
      skipEmailLog: true,
    });

    await supabaseAdmin
      .from("vouchers")
      .update({
        email_status: result.status,
        email_sent_at: result.status === "sent" ? new Date().toISOString() : null,
        email_error: result.error_message || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", voucher.id)
      .eq("tenant_id", tenant.id);

    return jsonResponse(
      {
        ok: true,
        event_type: "voucher_issued",
        status: result.status,
        reason: result.reason || null,
        recipient_email: recipient,
        provider_message_id: result.provider_message_id || null,
      },
      origin,
      200
    );
  }

  const orderId = String(body.order_id || "").trim();
  if (!UUID_REGEX.test(orderId)) {
    return jsonResponse({ ok: false, error: "Order ID tidak valid." }, origin, 400);
  }

  const { data: order, error: orderErr } = await supabaseAdmin
    .from("orders")
    .select(
      "id, ticket_code, customer_id, customer_name, customer_email, status, order_type, total_amount, paid_amount, outbound_courier, outbound_tracking"
    )
    .eq("id", orderId)
    .eq("tenant_id", tenant.id)
    .maybeSingle();

  if (orderErr || !order) {
    return jsonResponse({ ok: false, error: "Order tidak ditemukan." }, origin, 404);
  }

  let recipient = normalizeEmail(order.customer_email);
  if (!recipient && order.customer_id) {
    const { data: customer } = await supabaseAdmin
      .from("customers")
      .select("email")
      .eq("id", order.customer_id)
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    recipient = normalizeEmail(customer?.email);
  }

  if (!recipient || !isValidEmail(recipient)) {
    if (isStaffCaller) {
      return jsonResponse({ ok: true, event_type: eventType, status: "accepted" }, origin, 200);
    }
    return jsonResponse(
      {
        ok: true,
        event_type: eventType,
        status: "skipped",
        reason: "no_recipient_email",
      },
      origin,
      200
    );
  }

  const trackingUrl = `${env.appBaseUrl}/t/${encodeURIComponent(tenant.slug)}`;
  const rendered =
    eventType === "order_ready"
      ? buildOrderReadyEmail({
          locale,
          workshopName: tenant.name,
          ticketCode: order.ticket_code,
          customerName: order.customer_name,
          orderType: order.order_type || "walk_in",
          totalAmount: Number(order.total_amount || 0),
          paidAmount: Number(order.paid_amount || 0),
          currency,
          trackingUrl,
        })
      : buildOrderCompletedEmail({
          locale,
          workshopName: tenant.name,
          ticketCode: order.ticket_code,
          customerName: order.customer_name,
          orderType: order.order_type || "walk_in",
          outboundCourier: order.outbound_courier,
          outboundTracking: order.outbound_tracking,
          trackingUrl,
        });

  const result = await sendResendEmailAndLog(supabaseAdmin, {
    tenantId: tenant.id,
    eventType: eventType as "order_ready" | "order_completed",
    recipientEmail: recipient,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    locale,
    replyTo: tenant.notification_email || null,
    relatedEntityType: "order",
    relatedEntityId: order.id,
    createdBy: caller.id,
  });

  // Zero-PII rule: never expose customer email or email-containing error details to staff callers.
  if (isStaffCaller) {
    return jsonResponse({ ok: true, event_type: eventType, status: "accepted" }, origin, 200);
  }

  return jsonResponse(
    {
      ok: true,
      event_type: eventType,
      status: result.status,
      reason: result.reason || null,
      recipient_email: recipient,
      provider_message_id: result.provider_message_id || null,
    },
    origin,
    200
  );
});
