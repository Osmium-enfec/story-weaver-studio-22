import { createServerFn } from "@tanstack/react-start";

export const seedAdminUser = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const email = "divyanshu.singh@enfec.com";
  const password = "Enfec777*";
  const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers();
  if (listErr) throw listErr;
  const existing = list.users.find((u) => u.email === email);
  if (existing) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });
    if (error) throw error;
    return { ok: true, action: "updated" as const };
  }
  const { error } = await supabaseAdmin.auth.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return { ok: true, action: "created" as const };
});
