"use client";
import { AuthGuard } from "@/components/auth-guard";
import { Shell } from "@/components/shell";
import { SlackSettingsPageContent } from "@/components/slack-settings";
export default function SlackSettingsPage() {
  return <AuthGuard>{(user) => <Shell user={user}><SlackSettingsPageContent ownerUid={user.id} /></Shell>}</AuthGuard>;
}
