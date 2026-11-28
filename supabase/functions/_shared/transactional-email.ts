import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type SupportedLocale = "id" | "en";
export type TransactionalEventType =
  | "team_invite"
  | "quote_received_customer"
  | "quote_received_workshop"
  | "quote_published"
  | "order_ready"
  | "order_completed"
  | "voucher_issued";

export type EmailDeliveryStatus = "sent" | "failed" | "skipped";
export type RelatedEntityType = "invitation" | "quote" | "order";

export interface EmailEnvConfig {
  apiKey: string;
  fromEmail: string;
  appBaseUrl: string;
}

export interface SendAndLogParams {
  tenantId: string;
  eventType: TransactionalEventType;
  recipientEmail: string;
  subject: string;
  html: string;
  text: string;
  locale: SupportedLocale;
  replyTo?: string | null;
  relatedEntityType?: RelatedEntityType | null;
  relatedEntityId?: string | null;
  createdBy?: string | null;
  skipEmailLog?: boolean;
}

export interface SendAndLogResult {
  status: EmailDeliveryStatus;
  reason?: string;
  provider_message_id?: string | null;
  error_message?: string | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 8000;
const ZERO_DECIMAL_CURRENCIES = new Set(["IDR", "JPY"]);

export function normalizeLocale(raw: unknown): SupportedLocale {
  return String(raw || "").trim().toLowerCase() === "en" ? "en" : "id";
}

export function normalizeEmail(raw: unknown): string | null {
  const cleaned = String(raw || "").trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.length <= 254 && EMAIL_REGEX.test(email);
}

export function escapeHtml(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getEmailEnvConfig(): EmailEnvConfig {
  const apiKey = String(Deno.env.get("RESEND_API_KEY") || "").trim();
  const fromEmail = String(Deno.env.get("RESEND_FROM_EMAIL") || "").trim();
  const rawBase = String(Deno.env.get("APP_BASE_URL") || "https://mendtrack.vercel.app").trim();
  const appBaseUrl = (rawBase || "https://mendtrack.vercel.app").replace(/\/+$/, "");
  return { apiKey, fromEmail, appBaseUrl };
}

export function formatCurrency(amount: number, currency = "IDR", locale: SupportedLocale = "id"): string {
  const safeNum = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  const code = String(currency || "IDR").trim().toUpperCase();
  const decimals = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
  const intlLocale = locale === "en" ? "en-US" : "id-ID";
  try {
    return new Intl.NumberFormat(intlLocale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(safeNum);
  } catch {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(safeNum);
  }
}

export function formatDateLocalized(
  dateStr: string | null | undefined,
  locale: SupportedLocale = "id",
  timezone?: string | null
): string {
  if (!dateStr) return "-";
  const intlLocale = locale === "en" ? "en-US" : "id-ID";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  };

  let dateObj: Date;
  if (dateOnly) {
    dateObj = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12, 0, 0));
  } else {
    dateObj = new Date(dateStr);
    if (timezone) {
      options.timeZone = timezone;
    }
  }
  if (Number.isNaN(dateObj.getTime())) return String(dateStr);

  try {
    return new Intl.DateTimeFormat(intlLocale, options).format(dateObj);
  } catch {
    delete options.timeZone;
    return new Intl.DateTimeFormat(intlLocale, options).format(dateObj);
  }
}

function truncateError(msg: unknown): string {
  const str = String(msg || "Unknown error").replace(/\s+/g, " ").trim();
  return str.length > 300 ? `${str.slice(0, 297)}...` : str;
}

export async function recordEmailLog(
  supabaseAdmin: SupabaseClient,
  entry: {
    tenant_id: string;
    event_type: TransactionalEventType;
    recipient_email: string;
    subject: string;
    locale: SupportedLocale;
    status: EmailDeliveryStatus;
    provider?: string;
    provider_message_id?: string | null;
    error_message?: string | null;
    related_entity_type?: RelatedEntityType | null;
    related_entity_id?: string | null;
    created_by?: string | null;
  }
): Promise<void> {
  try {
    const cleanRecipient = normalizeEmail(entry.recipient_email);
    if (!cleanRecipient || !isValidEmail(cleanRecipient)) return;
    const { error } = await supabaseAdmin.from("email_logs").insert({
      tenant_id: entry.tenant_id,
      event_type: entry.event_type,
      recipient_email: cleanRecipient,
      subject: String(entry.subject || "").slice(0, 240),
      locale: entry.locale,
      status: entry.status,
      provider: entry.provider || "resend",
      provider_message_id: entry.provider_message_id || null,
      error_message: entry.error_message ? truncateError(entry.error_message) : null,
      related_entity_type: entry.related_entity_type || null,
      related_entity_id: entry.related_entity_id || null,
      created_by: entry.created_by || null,
    });
    if (error) {
      console.error("recordEmailLog insert warning:", error.message);
    }
  } catch (err) {
    console.error("recordEmailLog unexpected warning:", err instanceof Error ? err.message : String(err));
  }
}

export async function sendResendEmailAndLog(
  supabaseAdmin: SupabaseClient,
  params: SendAndLogParams
): Promise<SendAndLogResult> {
  const env = getEmailEnvConfig();
  const recipient = normalizeEmail(params.recipientEmail);
  if (!recipient || !isValidEmail(recipient)) {
    return { status: "skipped", reason: "invalid_recipient" };
  }

  if (!env.apiKey || !env.fromEmail) {
    const note =
      params.locale === "en"
        ? "Resend secrets (RESEND_API_KEY / RESEND_FROM_EMAIL) are not configured yet."
        : "Secret Resend (RESEND_API_KEY / RESEND_FROM_EMAIL) belum dikonfigurasi.";
    if (!params.skipEmailLog) {
      await recordEmailLog(supabaseAdmin, {
        tenant_id: params.tenantId,
        event_type: params.eventType,
        recipient_email: recipient,
        subject: params.subject,
        locale: params.locale,
        status: "skipped",
        error_message: note,
        related_entity_type: params.relatedEntityType || null,
        related_entity_id: params.relatedEntityId || null,
        created_by: params.createdBy || null,
      });
    }
    return { status: "skipped", reason: "not_configured", error_message: note };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

  try {
    const payload: Record<string, unknown> = {
      from: env.fromEmail,
      to: [recipient],
      subject: params.subject,
      html: params.html,
      text: params.text,
    };
    const safeReplyTo = normalizeEmail(params.replyTo);
    if (safeReplyTo && isValidEmail(safeReplyTo)) {
      payload.reply_to = safeReplyTo;
    }

    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const rawText = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }

    if (res.ok) {
      const messageId = typeof parsed?.id === "string" ? parsed.id : null;
      if (!params.skipEmailLog) {
        await recordEmailLog(supabaseAdmin, {
          tenant_id: params.tenantId,
          event_type: params.eventType,
          recipient_email: recipient,
          subject: params.subject,
          locale: params.locale,
          status: "sent",
          provider_message_id: messageId,
          related_entity_type: params.relatedEntityType || null,
          related_entity_id: params.relatedEntityId || null,
          created_by: params.createdBy || null,
        });
      }
      return { status: "sent", provider_message_id: messageId };
    }

    const providerErr =
      (typeof parsed?.message === "string" && parsed.message) ||
      (typeof parsed?.error === "string" && parsed.error) ||
      `Resend HTTP ${res.status}`;
    const safeErr = truncateError(providerErr);

    if (!params.skipEmailLog) {
      await recordEmailLog(supabaseAdmin, {
        tenant_id: params.tenantId,
        event_type: params.eventType,
        recipient_email: recipient,
        subject: params.subject,
        locale: params.locale,
        status: "failed",
        error_message: safeErr,
        related_entity_type: params.relatedEntityType || null,
        related_entity_id: params.relatedEntityId || null,
        created_by: params.createdBy || null,
      });
    }
    return { status: "failed", reason: "provider_error", error_message: safeErr };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const errMsg = truncateError(
      isAbort ? "Resend API timeout (8s)" : err instanceof Error ? err.message : String(err)
    );
    if (!params.skipEmailLog) {
      await recordEmailLog(supabaseAdmin, {
        tenant_id: params.tenantId,
        event_type: params.eventType,
        recipient_email: recipient,
        subject: params.subject,
        locale: params.locale,
        status: "failed",
        error_message: errMsg,
        related_entity_type: params.relatedEntityType || null,
        related_entity_id: params.relatedEntityId || null,
        created_by: params.createdBy || null,
      });
    }
    return { status: "failed", reason: isAbort ? "timeout" : "network_error", error_message: errMsg };
  } finally {
    clearTimeout(timer);
  }
}

interface CraftLedgerLayoutInput {
  locale: SupportedLocale;
  workshopName: string;
  badgeText?: string;
  title: string;
  introParagraphs: string[];
  details?: Array<{ label: string; value: string; mono?: boolean }>;
  extraHtml?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  footerNote?: string;
}

function renderCraftLedgerHtml(input: CraftLedgerLayoutInput): string {
  const lang = input.locale;
  const safeWorkshop = escapeHtml(input.workshopName || "MendTrack");
  const safeTitle = escapeHtml(input.title);
  const badgeHtml = input.badgeText
    ? `<p style="margin:0 0 10px 0;"><span style="display:inline-block;padding:4px 10px;border-radius:4px;background-color:#ECE7DC;color:#18253E;font-size:12px;font-weight:700;letter-spacing:0.2px;">${escapeHtml(
        input.badgeText
      )}</span></p>`
    : "";

  const introHtml = input.introParagraphs
    .map(
      (p) =>
        `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.65;color:#4A5568;">${escapeHtml(p)}</p>`
    )
    .join("");

  const detailsHtml =
    input.details && input.details.length > 0
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;background-color:#F5F2EB;border:1px solid #D8D1C4;border-radius:8px;">
          ${input.details
            .map((row, idx) => {
              const borderTop = idx > 0 ? "border-top:1px dashed #D8D1C4;" : "";
              const valFont = row.mono
                ? "font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-weight:700;"
                : "font-weight:600;";
              return `<tr>
                <td style="padding:10px 14px;${borderTop}font-size:12px;color:#4A5568;width:40%;vertical-align:top;">${escapeHtml(
                row.label
              )}</td>
                <td style="padding:10px 14px;${borderTop}font-size:13px;color:#18253E;${valFont}vertical-align:top;word-break:break-word;">${escapeHtml(
                row.value
              )}</td>
              </tr>`;
            })
            .join("")}
        </table>`
      : "";

  const ctaHtml =
    input.ctaLabel && input.ctaUrl
      ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0 14px 0;">
          <tr>
            <td align="center" style="border-radius:8px;background-color:#9E4316;">
              <a href="${escapeHtml(
                input.ctaUrl
              )}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:13px 24px;font-size:14px;font-weight:700;color:#FFFDF9;text-decoration:none;border-radius:8px;">${escapeHtml(
          input.ctaLabel
        )}</a>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 8px 0;font-size:12px;line-height:1.55;color:#4A5568;">${
          lang === "en"
            ? "If the button does not open, copy and paste this link into your browser:"
            : "Jika tombol tidak terbuka, salin dan tempel tautan ini ke browser Anda:"
        }</p>
        <div style="background-color:#ECE7DC;border:1px solid #D8D1C4;border-radius:8px;padding:10px 12px;word-break:break-all;font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-size:12px;line-height:1.5;color:#18253E;">${escapeHtml(
          input.ctaUrl
        )}</div>`
      : "";

  const footerText =
    input.footerNote ||
    (lang === "en"
      ? `Sent automatically via MendTrack on behalf of ${input.workshopName}.`
      : `Dikirim otomatis melalui MendTrack atas nama ${input.workshopName}.`);

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F2EB;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18253E;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F5F2EB;padding:24px 14px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background-color:#FFFDF9;border:1px solid #D8D1C4;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background-color:#18253E;padding:22px 26px;border-bottom:2px dashed #9E4316;">
              <p style="margin:0;font-size:17px;font-weight:700;color:#FFFDF9;">${safeWorkshop}</p>
              <p style="margin:4px 0 0 0;font-size:12px;color:#ECE7DC;">MendTrack Craft Ledger</p>
            </td>
          </tr>
          <tr>
            <td style="padding:26px 26px 22px 26px;">
              ${badgeHtml}
              <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.35;font-weight:700;color:#18253E;">${safeTitle}</h1>
              ${introHtml}
              ${detailsHtml}
              ${input.extraHtml || ""}
              ${ctaHtml}
            </td>
          </tr>
          <tr>
            <td style="background-color:#ECE7DC;padding:14px 26px;border-top:1px solid #D8D1C4;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#4A5568;">${escapeHtml(footerText)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function getRoleLabel(role: string, locale: SupportedLocale): string {
  const r = String(role || "").toLowerCase();
  if (r === "owner") return locale === "en" ? "Owner" : "Pemilik";
  if (r === "admin") return "Admin";
  return "Staff";
}

function getOrderTypeLabel(orderType: string, locale: SupportedLocale): string {
  if (orderType === "mail_in") {
    return locale === "en" ? "Mail-In Parcel" : "Kirim Paket (Mail-In)";
  }
  return locale === "en" ? "Walk-In Drop-off" : "Antar Langsung (Walk-In)";
}

export function buildTeamInviteEmail(input: {
  locale: SupportedLocale;
  workshopName: string;
  invitedRole: string;
  expiresAt: string;
  timezone?: string | null;
  inviteUrl: string;
}): { subject: string; html: string; text: string } {
  const { locale, workshopName, invitedRole, expiresAt, timezone, inviteUrl } = input;
  const roleLabel = getRoleLabel(invitedRole, locale);
  const expiryFormatted = formatDateLocalized(expiresAt, locale, timezone);

  const subject =
    locale === "en"
      ? `You are invited to join ${workshopName} on MendTrack`
      : `Undangan bergabung ke tim ${workshopName} di MendTrack`;

  const html = renderCraftLedgerHtml({
    locale,
    workshopName,
    badgeText: locale === "en" ? "Team Invitation" : "Undangan Tim",
    title:
      locale === "en"
        ? `Join ${workshopName} as ${roleLabel}`
        : `Bergabung ke ${workshopName} sebagai ${roleLabel}`,
    introParagraphs:
      locale === "en"
        ? [
            `You have been invited to join the ${workshopName} workspace on MendTrack with the ${roleLabel} role.`,
            "Click the button below to accept the invitation using this exact email address (Email sign-in/sign-up or Google SSO).",
          ]
        : [
            `Anda diundang untuk bergabung ke workspace ${workshopName} di MendTrack dengan peran ${roleLabel}.`,
            "Klik tombol di bawah ini untuk menerima undangan menggunakan alamat email yang sama (via Email atau Google SSO).",
          ],
    details: [
      { label: locale === "en" ? "Workshop" : "Workshop", value: workshopName },
      { label: locale === "en" ? "Assigned Role" : "Peran", value: roleLabel },
      { label: locale === "en" ? "Valid Until" : "Berlaku Hingga", value: expiryFormatted },
    ],
    ctaLabel: locale === "en" ? "Accept Invitation" : "Terima Undangan",
    ctaUrl: inviteUrl,
  });

  const text =
    locale === "en"
      ? `${subject}\n\nWorkshop: ${workshopName}\nRole: ${roleLabel}\nValid until: ${expiryFormatted}\n\nAccept invitation: ${inviteUrl}`
      : `${subject}\n\nWorkshop: ${workshopName}\nPeran: ${roleLabel}\nBerlaku hingga: ${expiryFormatted}\n\nTerima undangan: ${inviteUrl}`;

  return { subject, html, text };
}

export function buildQuoteReceivedCustomerEmail(input: {
  locale: SupportedLocale;
  workshopName: string;
  quoteCode: string;
  customerName: string;
  garmentName: string;
  orderType: string;
  trackingUrl: string;
  adminPhone?: string | null;
}): { subject: string; html: string; text: string } {
  const { locale, workshopName, quoteCode, customerName, garmentName, orderType, trackingUrl, adminPhone } = input;
  const handoffLabel = getOrderTypeLabel(orderType, locale);

  const subject =
    locale === "en"
      ? `Estimate Request ${quoteCode} Received by ${workshopName}`
      : `Permintaan Estimasi ${quoteCode} Diterima oleh ${workshopName}`;

  const details: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: locale === "en" ? "Reference Code" : "Kode Estimasi", value: quoteCode, mono: true },
    { label: locale === "en" ? "Garment" : "Pakaian", value: garmentName },
    { label: locale === "en" ? "Service Method" : "Metode Serah Terima", value: handoffLabel },
  ];
  if (adminPhone) {
    details.push({
      label: locale === "en" ? "Workshop WhatsApp" : "WhatsApp Workshop",
      value: adminPhone,
      mono: true,
    });
  }

  const html = renderCraftLedgerHtml({
    locale,
    workshopName,
    badgeText: locale === "en" ? "Estimate Request Received" : "Permintaan Estimasi Diterima",
    title:
      locale === "en"
        ? `Thank you, ${customerName}`
        : `Terima kasih, ${customerName}`,
    introParagraphs:
      locale === "en"
        ? [
            `Your visual repair estimate request for ${garmentName} has been received by ${workshopName}.`,
            "Our workshop team is reviewing your garment photo and damage pins. Once pricing and turnaround are ready, we will send your online approval link via email and WhatsApp.",
          ]
        : [
            `Permintaan estimasi reparasi untuk ${garmentName} telah diterima oleh ${workshopName}.`,
            "Tim workshop kami sedang meninjau foto pakaian dan titik kerusakan Anda. Setelah rincian biaya dan estimasi selesai disiapkan, kami akan mengirimkan tautan persetujuan melalui email dan WhatsApp.",
          ],
    details,
    ctaLabel: locale === "en" ? "Visit Workshop Portal" : "Buka Portal Workshop",
    ctaUrl: trackingUrl,
  });

  const text =
    locale === "en"
      ? `${subject}\n\nHi ${customerName},\nYour repair estimate request (${quoteCode}) for ${garmentName} (${handoffLabel}) has been received by ${workshopName}.\nPortal: ${trackingUrl}`
      : `${subject}\n\nHalo ${customerName},\nPermintaan estimasi reparasi (${quoteCode}) untuk ${garmentName} (${handoffLabel}) telah diterima oleh ${workshopName}.\nPortal: ${trackingUrl}`;

  return { subject, html, text };
}

export function buildQuoteReceivedWorkshopEmail(input: {
  locale: SupportedLocale;
  workshopName: string;
  quoteCode: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  garmentName: string;
  orderType: string;
  pinCount: number;
  adminUrl: string;
}): { subject: string; html: string; text: string } {
  const {
    locale,
    workshopName,
    quoteCode,
    customerName,
    customerPhone,
    customerEmail,
    garmentName,
    orderType,
    pinCount,
    adminUrl,
  } = input;

  const subject =
    locale === "en"
      ? `New Quote Request ${quoteCode}: ${garmentName}`
      : `Permintaan Quote Baru ${quoteCode}: ${garmentName}`;

  const details: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: locale === "en" ? "Quote Code" : "Kode Quote", value: quoteCode, mono: true },
    { label: locale === "en" ? "Customer" : "Pelanggan", value: customerName },
    { label: "WhatsApp", value: customerPhone, mono: true },
  ];
  if (customerEmail) {
    details.push({ label: "Email", value: customerEmail, mono: true });
  }
  details.push(
    { label: locale === "en" ? "Garment" : "Pakaian", value: garmentName },
    { label: locale === "en" ? "Handoff Type" : "Tipe Layanan", value: getOrderTypeLabel(orderType, locale) },
    {
      label: locale === "en" ? "Damage Pins" : "Titik Kerusakan",
      value: locale === "en" ? `${pinCount} pin(s)` : `${pinCount} titik`,
      mono: true,
    }
  );

  const html = renderCraftLedgerHtml({
    locale,
    workshopName,
    badgeText: locale === "en" ? "New Incoming Quote" : "Permintaan Quote Baru",
    title:
      locale === "en"
        ? `New estimate request from ${customerName}`
        : `Permintaan estimasi baru dari ${customerName}`,
    introParagraphs:
      locale === "en"
        ? [
            `A customer submitted a visual repair intake request (${quoteCode}) for ${workshopName}.`,
            "Open Quote Requests in your MendTrack Admin dashboard to inspect the annotated photo, set pricing, and publish the approval link.",
          ]
        : [
            `Pelanggan baru saja mengirim permintaan estimasi visual (${quoteCode}) ke ${workshopName}.`,
            "Buka menu Permintaan Quote di dashboard Admin MendTrack untuk meninjau foto pin kerusakan, menyusun rincian biaya, dan menerbitkan tautan persetujuan.",
          ],
    details,
    ctaLabel: locale === "en" ? "Open Admin Dashboard" : "Buka Dashboard Admin",
    ctaUrl: adminUrl,
  });

  const text =
    locale === "en"
      ? `${subject}\n\nCustomer: ${customerName} (${customerPhone})\nGarment: ${garmentName}\nDamage pins: ${pinCount}\nOpen Admin: ${adminUrl}`
      : `${subject}\n\nPelanggan: ${customerName} (${customerPhone})\nPakaian: ${garmentName}\nTitik kerusakan: ${pinCount}\nBuka Admin: ${adminUrl}`;

  return { subject, html, text };
}

export function buildQuotePublishedEmail(input: {
  locale: SupportedLocale;
  workshopName: string;
  quoteCode: string;
  customerName: string;
  garmentName: string;
  items: Array<{ garment_name?: string; service_type?: string; price?: number }>;
  total: number;
  currency: string;
  estimatedDays?: number | null;
  estimatedDoneDate?: string | null;
  workshopNotes?: string | null;
  approvalUrl: string;
}): { subject: string; html: string; text: string } {
  const {
    locale,
    workshopName,
    quoteCode,
    customerName,
    garmentName,
    items,
    total,
    currency,
    estimatedDays,
    estimatedDoneDate,
    workshopNotes,
    approvalUrl,
  } = input;

  const formattedTotal = formatCurrency(total, currency, locale);
  const subject =
    locale === "en"
      ? `Repair Estimate ${quoteCode} Ready for Approval (${workshopName})`
      : `Estimasi Biaya ${quoteCode} Siap Disetujui (${workshopName})`;

  const details: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: locale === "en" ? "Quote Code" : "Kode Quote", value: quoteCode, mono: true },
    { label: locale === "en" ? "Garment" : "Pakaian", value: garmentName },
    { label: locale === "en" ? "Total Estimate" : "Total Estimasi", value: formattedTotal, mono: true },
  ];

  if (estimatedDoneDate) {
    details.push({
      label: locale === "en" ? "Target Completion" : "Estimasi Selesai",
      value: formatDateLocalized(estimatedDoneDate, locale),
    });
  } else if (estimatedDays && estimatedDays > 0) {
    details.push({
      label: locale === "en" ? "Estimated Turnaround" : "Estimasi Pengerjaan",
      value: locale === "en" ? `${estimatedDays} day(s)` : `${estimatedDays} hari`,
    });
  }

  let itemsHtml = "";
  if (items.length > 0) {
    const rows = items
      .map((item) => {
        const label = [item.garment_name, item.service_type].filter(Boolean).join(" / ") || garmentName;
        const priceStr = formatCurrency(Number(item.price || 0), currency, locale);
        return `<tr>
          <td style="padding:8px 12px;border-top:1px dashed #D8D1C4;font-size:13px;color:#18253E;">${escapeHtml(label)}</td>
          <td align="right" style="padding:8px 12px;border-top:1px dashed #D8D1C4;font-size:13px;font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-weight:600;color:#18253E;white-space:nowrap;">${escapeHtml(priceStr)}</td>
        </tr>`;
      })
      .join("");
    itemsHtml = `<p style="margin:14px 0 8px 0;font-size:13px;font-weight:700;color:#18253E;">${
      locale === "en" ? "Itemized Breakdown" : "Rincian Pekerjaan"
    }</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 14px 0;background-color:#FFFDF9;border:1px solid #D8D1C4;border-radius:8px;">
      ${rows}
    </table>`;
  }

  const notesHtml = workshopNotes
    ? `<div style="margin:12px 0;padding:12px 14px;background-color:#ECE7DC;border-left:3px solid #9E4316;border-radius:6px;">
        <p style="margin:0 0 4px 0;font-size:12px;font-weight:700;color:#18253E;">${
          locale === "en" ? "Workshop Notes" : "Catatan Workshop"
        }</p>
        <p style="margin:0;font-size:13px;line-height:1.55;color:#4A5568;">${escapeHtml(workshopNotes)}</p>
      </div>`
    : "";

  const html = renderCraftLedgerHtml({
    locale,
    workshopName,
    badgeText: locale === "en" ? "Quote Ready for Review" : "Estimasi Siap Ditinjau",
    title:
      locale === "en"
        ? `Your repair estimate is ready, ${customerName}`
        : `Estimasi reparasi Anda sudah siap, ${customerName}`,
    introParagraphs:
      locale === "en"
        ? [
            `${workshopName} has prepared the cost breakdown for ${garmentName} (${quoteCode}).`,
            "Review the itemized repair list and approve online to turn your estimate into an official workshop ticket.",
          ]
        : [
            `${workshopName} telah menyiapkan rincian biaya untuk ${garmentName} (${quoteCode}).`,
            "Tinjau daftar pekerjaan di bawah ini lalu setujui secara online agar estimasi langsung diproses menjadi tiket order resmi.",
          ],
    details,
    extraHtml: itemsHtml + notesHtml,
    ctaLabel: locale === "en" ? "Review & Approve Estimate" : "Tinjau & Setujui Estimasi",
    ctaUrl: approvalUrl,
  });

  const text =
    locale === "en"
      ? `${subject}\n\nHi ${customerName},\nTotal estimate: ${formattedTotal}\nReview and approve online: ${approvalUrl}`
      : `${subject}\n\nHalo ${customerName},\nTotal estimasi: ${formattedTotal}\nTinjau dan setujui online: ${approvalUrl}`;

  return { subject, html, text };
}

export function buildOrderReadyEmail(input: {
  locale: SupportedLocale;
  workshopName: string;
  ticketCode: string;
  customerName: string;
  orderType: string;
  totalAmount: number;
  paidAmount: number;
  currency: string;
  trackingUrl: string;
}): { subject: string; html: string; text: string } {
  const {
    locale,
    workshopName,
    ticketCode,
    customerName,
    orderType,
    totalAmount,
    paidAmount,
    currency,
    trackingUrl,
  } = input;

  const isMailIn = orderType === "mail_in";
  const remaining = Math.max(0, Number(totalAmount || 0) - Number(paidAmount || 0));
  const remainingStr = formatCurrency(remaining, currency, locale);
  const totalStr = formatCurrency(Number(totalAmount || 0), currency, locale);

  const subject =
    locale === "en"
      ? isMailIn
        ? `Order ${ticketCode} is Ready to Ship (${workshopName})`
        : `Order ${ticketCode} is Ready for Pickup (${workshopName})`
      : isMailIn
        ? `Order ${ticketCode} Siap Dikirim (${workshopName})`
        : `Order ${ticketCode} Siap Diambil (${workshopName})`;

  const details: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: locale === "en" ? "Ticket Code" : "Kode Tiket", value: ticketCode, mono: true },
    {
      label: locale === "en" ? "Status" : "Status",
      value:
        locale === "en"
          ? isMailIn
            ? "Ready to Ship"
            : "Ready for Pickup"
          : isMailIn
            ? "Siap Dikirim"
            : "Siap Diambil",
    },
    { label: locale === "en" ? "Order Total" : "Total Biaya", value: totalStr, mono: true },
    {
      label: locale === "en" ? "Remaining Balance" : "Sisa Pembayaran",
      value: remaining > 0 ? remainingStr : locale === "en" ? "Paid in full" : "Lunas",
      mono: true,
    },
  ];

  const introParagraphs =
    locale === "en"
      ? isMailIn
        ? [
            `Good news, ${customerName}! Your garment under ticket ${ticketCode} at ${workshopName} is finished and ready for return shipment.`,
            remaining > 0
              ? `Remaining balance to settle before shipping: ${remainingStr}.`
              : "Your payment is settled in full. We will notify you again once the return tracking number is issued.",
          ]
        : [
            `Good news, ${customerName}! Your garment under ticket ${ticketCode} at ${workshopName} is finished and ready for pickup.`,
            remaining > 0
              ? `Remaining balance due at pickup: ${remainingStr}.`
              : "Your payment is already settled in full.",
          ]
      : isMailIn
        ? [
            `Kabar baik, ${customerName}! Pengerjaan untuk tiket ${ticketCode} di ${workshopName} telah selesai dan siap dikirim kembali.`,
            remaining > 0
              ? `Sisa tagihan yang perlu dilunasi sebelum pengiriman: ${remainingStr}.`
              : "Pembayaran Anda sudah lunas. Kami akan mengabarkan kembali setelah resi pengiriman keluar diterbitkan.",
          ]
        : [
            `Kabar baik, ${customerName}! Pengerjaan untuk tiket ${ticketCode} di ${workshopName} telah selesai dan siap diambil.`,
            remaining > 0
              ? `Sisa tagihan saat pengambilan: ${remainingStr}.`
              : "Pembayaran Anda sudah lunas.",
          ];

  const html = renderCraftLedgerHtml({
    locale,
    workshopName,
    badgeText:
      locale === "en"
        ? isMailIn
          ? "Ready to Ship"
          : "Ready for Pickup"
        : isMailIn
          ? "Siap Dikirim"
          : "Siap Diambil",
    title:
      locale === "en"
        ? isMailIn
          ? `Order ${ticketCode} is ready to ship`
          : `Order ${ticketCode} is ready for pickup`
        : isMailIn
          ? `Order ${ticketCode} siap dikirim`
          : `Order ${ticketCode} siap diambil`,
    introParagraphs,
    details,
    ctaLabel: locale === "en" ? "Check Order Status" : "Lihat Status Order",
    ctaUrl: trackingUrl,
  });

  const text =
    locale === "en"
      ? `${subject}\n\nHi ${customerName},\nTicket: ${ticketCode}\nRemaining balance: ${remaining > 0 ? remainingStr : "Paid in full"}\nTrack order: ${trackingUrl}`
      : `${subject}\n\nHalo ${customerName},\nTiket: ${ticketCode}\nSisa pembayaran: ${remaining > 0 ? remainingStr : "Lunas"}\nLacak order: ${trackingUrl}`;

  return { subject, html, text };
}

export function buildOrderCompletedEmail(input: {
  locale: SupportedLocale;
  workshopName: string;
  ticketCode: string;
  customerName: string;
  orderType: string;
  outboundCourier?: string | null;
  outboundTracking?: string | null;
  trackingUrl: string;
}): { subject: string; html: string; text: string } {
  const {
    locale,
    workshopName,
    ticketCode,
    customerName,
    orderType,
    outboundCourier,
    outboundTracking,
    trackingUrl,
  } = input;

  const isMailIn = orderType === "mail_in";
  const subject =
    locale === "en"
      ? isMailIn
        ? `Order ${ticketCode} Completed & Shipped (${workshopName})`
        : `Order ${ticketCode} Completed (${workshopName})`
      : isMailIn
        ? `Order ${ticketCode} Selesai & Dikirim (${workshopName})`
        : `Order ${ticketCode} Selesai (${workshopName})`;

  const details: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: locale === "en" ? "Ticket Code" : "Kode Tiket", value: ticketCode, mono: true },
    {
      label: locale === "en" ? "Status" : "Status",
      value:
        locale === "en"
          ? isMailIn
            ? "Completed & Shipped"
            : "Completed & Picked Up"
          : isMailIn
            ? "Selesai & Dikirim"
            : "Selesai & Diambil",
    },
  ];

  if (isMailIn && outboundCourier) {
    details.push({
      label: locale === "en" ? "Return Courier" : "Kurir Pengiriman",
      value: outboundCourier,
    });
  }
  if (isMailIn && outboundTracking) {
    details.push({
      label: locale === "en" ? "Return Tracking Number" : "Nomor Resi Keluar",
      value: outboundTracking,
      mono: true,
    });
  }

  const introParagraphs =
    locale === "en"
      ? isMailIn
        ? [
            `Thank you, ${customerName}! Your order ${ticketCode} at ${workshopName} is completed and has been handed over for return delivery.`,
            outboundTracking
              ? `Use tracking number ${outboundTracking}${outboundCourier ? ` (${outboundCourier})` : ""} to monitor your parcel.`
              : "You can check your completed order summary anytime via the tracking portal below.",
          ]
        : [
            `Thank you, ${customerName}! Your order ${ticketCode} at ${workshopName} is marked as completed and picked up.`,
            "We appreciate your trust in our workshop. You can view your order record anytime using the link below.",
          ]
      : isMailIn
        ? [
            `Terima kasih, ${customerName}! Order ${ticketCode} Anda di ${workshopName} telah selesai dan dikirim kembali.`,
            outboundTracking
              ? `Gunakan nomor resi ${outboundTracking}${outboundCourier ? ` (${outboundCourier})` : ""} untuk memantau perjalanan paket Anda.`
              : "Anda dapat melihat ringkasan order selesai kapan saja melalui portal pelacakan di bawah ini.",
          ]
        : [
            `Terima kasih, ${customerName}! Order ${ticketCode} Anda di ${workshopName} telah selesai dan diambil.`,
            "Terima kasih telah mempercayakan perawatan pakaian Anda kepada workshop kami.",
          ];

  const html = renderCraftLedgerHtml({
    locale,
    workshopName,
    badgeText:
      locale === "en"
        ? isMailIn
          ? "Completed & Shipped"
          : "Order Completed"
        : isMailIn
          ? "Selesai & Dikirim"
          : "Order Selesai",
    title:
      locale === "en"
        ? isMailIn
          ? `Order ${ticketCode} is on its way`
          : `Order ${ticketCode} is complete`
        : isMailIn
          ? `Order ${ticketCode} telah dikirim`
          : `Order ${ticketCode} selesai`,
    introParagraphs,
    details,
    ctaLabel: locale === "en" ? "View Order Portal" : "Buka Portal Pelacakan",
    ctaUrl: trackingUrl,
  });

  const textLines = [
    subject,
    "",
    locale === "en" ? `Hi ${customerName},` : `Halo ${customerName},`,
    `${locale === "en" ? "Ticket" : "Tiket"}: ${ticketCode}`,
  ];
  if (isMailIn && outboundCourier) {
    textLines.push(`${locale === "en" ? "Courier" : "Kurir"}: ${outboundCourier}`);
  }
  if (isMailIn && outboundTracking) {
    textLines.push(`${locale === "en" ? "Tracking" : "Resi"}: ${outboundTracking}`);
  }
  textLines.push(`${locale === "en" ? "Portal" : "Portal"}: ${trackingUrl}`);

  return { subject, html, text: textLines.join("\n") };
}

export function buildVoucherIssuedEmail(input: {
  locale: SupportedLocale;
  workshopName: string;
  customerName: string;
  voucherCode: string;
  discountType: string;
  discountValue: number;
  currency: string;
  expiresAt?: string | null;
  notes?: string | null;
  trackingUrl: string;
}): { subject: string; html: string; text: string } {
  const {
    locale,
    workshopName,
    customerName,
    voucherCode,
    discountType,
    discountValue,
    currency,
    expiresAt,
    notes,
    trackingUrl,
  } = input;

  const isPercent = discountType === "percent";
  const valueLabel = isPercent
    ? `${Number(discountValue || 0)}%`
    : formatCurrency(Number(discountValue || 0), currency, locale);
  const expiryLabel = expiresAt
    ? formatDateLocalized(expiresAt, locale)
    : locale === "en"
      ? "No expiration date"
      : "Tanpa batas waktu";

  const subject =
    locale === "en"
      ? `Special ${valueLabel} Loyalty Voucher from ${workshopName}`
      : `Voucher Spesial ${valueLabel} dari ${workshopName}`;

  const safeCustomer = customerName || (locale === "en" ? "Valued Customer" : "Pelanggan Setia");

  const voucherBoxHtml = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;background-color:#F5F2EB;border:2px dashed #9E4316;border-radius:10px;">
    <tr>
      <td align="center" style="padding:20px 16px;">
        <p style="margin:0 0 6px 0;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#4A5568;">${
          locale === "en" ? "Single-Use Loyalty Voucher" : "Voucher Loyalitas (1x Pakai)"
        }</p>
        <p style="margin:0 0 10px 0;font-size:28px;font-weight:800;color:#9E4316;line-height:1.15;">${escapeHtml(
          isPercent ? `${valueLabel} OFF` : valueLabel
        )}</p>
        <div style="display:inline-block;padding:8px 18px;background-color:#18253E;color:#FFFDF9;border-radius:6px;font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-size:16px;font-weight:700;letter-spacing:1.5px;">${escapeHtml(
          voucherCode
        )}</div>
        <p style="margin:10px 0 0 0;font-size:12px;color:#4A5568;">${
          locale === "en" ? `Valid until: ${expiryLabel}` : `Berlaku hingga: ${expiryLabel}`
        }</p>
      </td>
    </tr>
  </table>`;

  const notesHtml = notes
    ? `<div style="margin:12px 0;padding:12px 14px;background-color:#ECE7DC;border-left:3px solid #18253E;border-radius:6px;">
        <p style="margin:0 0 4px 0;font-size:12px;font-weight:700;color:#18253E;">${
          locale === "en" ? "Workshop Note" : "Catatan Workshop"
        }</p>
        <p style="margin:0;font-size:13px;line-height:1.55;color:#4A5568;">${escapeHtml(notes)}</p>
      </div>`
    : "";

  const html = renderCraftLedgerHtml({
    locale,
    workshopName,
    badgeText: locale === "en" ? "Loyalty Reward" : "Apresiasi Pelanggan Loyal",
    title:
      locale === "en"
        ? `A thank-you voucher for you, ${safeCustomer}`
        : `Voucher apresiasi untuk Anda, ${safeCustomer}`,
    introParagraphs:
      locale === "en"
        ? [
            `Thank you for trusting ${workshopName} with your garments. Please enjoy this single-use loyalty voucher on your next repair or custom tailoring order.`,
            "Mention or show the voucher code below when placing your next order at the workshop.",
          ]
        : [
            `Terima kasih telah mempercayakan perawatan dan pengerjaan pakaian Anda kepada ${workshopName}. Nikmati voucher spesial satu kali pakai ini untuk order berikutnya.`,
            "Tunjukkan atau sebutkan kode voucher di bawah ini saat membuat order berikutnya di workshop kami.",
          ],
    extraHtml: voucherBoxHtml + notesHtml,
    details: [
      { label: locale === "en" ? "Voucher Code" : "Kode Voucher", value: voucherCode, mono: true },
      { label: locale === "en" ? "Discount Value" : "Nilai Potongan", value: valueLabel, mono: true },
      { label: locale === "en" ? "Valid Until" : "Berlaku Hingga", value: expiryLabel },
    ],
    ctaLabel: locale === "en" ? "Visit Workshop Portal" : "Buka Portal Workshop",
    ctaUrl: trackingUrl,
  });

  const textLines = [
    subject,
    "",
    locale === "en" ? `Hi ${safeCustomer},` : `Halo ${safeCustomer},`,
    `${locale === "en" ? "Voucher Code" : "Kode Voucher"}: ${voucherCode}`,
    `${locale === "en" ? "Discount" : "Potongan"}: ${valueLabel}`,
    `${locale === "en" ? "Valid until" : "Berlaku hingga"}: ${expiryLabel}`,
  ];
  if (notes) {
    textLines.push(`${locale === "en" ? "Note" : "Catatan"}: ${notes}`);
  }
  textLines.push(`${locale === "en" ? "Workshop Portal" : "Portal Workshop"}: ${trackingUrl}`);

  return { subject, html, text: textLines.join("\n") };
}
