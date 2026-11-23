import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-billion-bootstrap-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
}
async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !anonKey || !serviceKey) {
    console.error("Billion enrollment runtime configuration is missing");
    return json({ error: "Enrollment service is not configured" }, 500);
  }
  const authorization = req.headers.get("Authorization") ?? "";
  const jwt = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!jwt) return json({ error: "Authentication required" }, 401);
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false } });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await caller.auth.getUser(jwt);
  if (userError || !userData.user) return json({ error: "Invalid session" }, 401);
  const userId = userData.user.id;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action ?? "");
  const deviceId = String(body.device_id ?? "");
  const deviceLabel = String(body.device_label ?? "").slice(0, 80);
  const platform = String(body.platform ?? "");
  if (!/^[A-Za-z0-9-]{8,128}$/.test(deviceId) || !["android", "ios", "web"].includes(platform)) {
    return json({ error: "Invalid device identity or platform" }, 400);
  }
  if (action === "bootstrap") {
    const bootstrapToken = req.headers.get("x-billion-bootstrap-token") ?? "";
    if (bootstrapToken.length < 32) return json({ error: "Bootstrap token is required" }, 401);
    const { data, error } = await admin.rpc("billion_bootstrap_company", {
      p_bootstrap_token: bootstrapToken, p_user_id: userId,
      p_company_name: String(body.company_name ?? "Billion").slice(0, 160),
      p_device_id: deviceId, p_device_label: deviceLabel, p_platform: platform,
    });
    if (error) { console.error("Billion bootstrap rejected:", error.message); return json({ error: error.message }, 400); }
    return json({ success: true, company_id: data });
  }
  if (action === "accept_invite") {
    const inviteToken = String(body.invite_token ?? "");
    if (inviteToken.length < 32) return json({ error: "Invitation token is required" }, 400);
    const { data, error } = await admin.rpc("billion_accept_company_invite", {
      p_invite_token: inviteToken, p_user_id: userId, p_device_id: deviceId,
      p_device_label: deviceLabel, p_platform: platform,
    });
    if (error) { console.error("Billion invite acceptance rejected:", error.message); return json({ error: error.message }, 400); }
    return json({ success: true, company_id: data });
  }
  if (action === "create_invite") {
    const { data: member, error: memberError } = await admin.from("billion_company_members")
      .select("company_id,role").eq("user_id", userId).maybeSingle();
    if (memberError || !member || !["owner", "admin"].includes(member.role)) {
      return json({ error: "Only a company owner or admin can create invitations" }, 403);
    }
    const { count, error: countError } = await admin.from("billion_company_devices")
      .select("device_id", { count: "exact", head: true })
      .eq("company_id", member.company_id).eq("status", "active");
    if (countError) return json({ error: "Could not verify active device count" }, 500);
    if ((count ?? 0) >= 3) return json({ error: "The three-device limit has already been reached" }, 409);
    const inviteToken = randomToken();
    const tokenHash = await sha256(inviteToken);
    const role = body.role === "viewer" ? "viewer" : "member";
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error: insertError } = await admin.from("billion_company_invites").insert({
      company_id: member.company_id, token_hash: tokenHash, role, created_by: userId, expires_at: expiresAt,
    });
    if (insertError) { console.error("Billion invitation creation failed:", insertError.message); return json({ error: "Could not create invitation" }, 500); }
    return json({ success: true, invite_token: inviteToken, expires_at: expiresAt });
  }
  return json({ error: "Unsupported enrollment action" }, 400);
});
