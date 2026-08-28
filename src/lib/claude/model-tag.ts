/**
 * `conversations.model_used` records who wrote a message. For model-written
 * rows it carries two things, because one of them is not enough: the *role*
 * that made the call ("sonnet" for a full conversational reply, "haiku" for a
 * preprocessing step) and the model that actually answered it. In production
 * both roles point at `deepseek-v4-flash`, so the model id alone cannot tell a
 * reply from a classification, and the role alone cannot tell you what really
 * ran — the column used to say "sonnet-4-6" for text DeepSeek wrote.
 *
 * Format is `role:model`. Everything that classifies a row does it on the role
 * prefix, which the legacy bare values ("sonnet-4-6", "sonnet-5", "haiku-4-5")
 * also start with, so rows written before this keep being counted.
 */
export type ModelRole = "sonnet" | "haiku";

export function modelRole(
  modelUsed: string | null | undefined,
): ModelRole | null {
  if (!modelUsed) return null;
  if (modelUsed.startsWith("sonnet")) return "sonnet";
  if (modelUsed.startsWith("haiku")) return "haiku";
  return null;
}
