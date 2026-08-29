interface Note {
  readonly note_id: string;
  readonly title: string;
  readonly content: string;
  readonly category: string;
  readonly tags: string[];
  readonly updated_at: number;
}

/**
 * Static message for the system prompt when persistent memory is disabled.
 * This is stable across the session and safe for prompt caching.
 *
 * Covers BOTH the note tools and the structured `memory` tool, because they
 * share a single gate (`areNotesEnabled` in lib/notes/gate.ts). Mentioning only
 * notes would leave the model unable to explain why it cannot remember things.
 */
export const getNotesDisabledMessage = (
  isFreeUser: boolean = false,
): string => `<notes>
The notes and memory tools are disabled. Do not use them. You cannot store anything that persists after this conversation.
${
  isFreeUser
    ? "If the user asks you to save or remember something, let them know that persistent notes and memory are available on paid plans and suggest upgrading."
    : "If the user asks you to save or remember something, politely ask them to go to **Settings > Personalization > Notes** to enable notes and memory."
}
</notes>`;

/**
 * Generate the notes section for injection via system-reminder in messages.
 * Only "general" category notes are passed here (filtered by getNotesForBackend).
 * Other categories must be retrieved via the list_notes tool.
 */
export const generateNotesSection = (notes: Note[] | null): string => {
  if (!notes || notes.length === 0) {
    return "";
  }

  const notesContent = notes
    .map((note) => {
      const date = new Date(note.updated_at).toISOString().split("T")[0];
      const tagsStr = note.tags.length > 0 ? ` [${note.tags.join(", ")}]` : "";
      return `- [${date}] **${note.title}**${tagsStr}: ${note.content} (ID: ${note.note_id})`;
    })
    .join("\n");

  return `<notes>
These are the user's general notes for context. Use them to provide more personalized assistance.

<user_notes>
${notesContent}
</user_notes>
</notes>`;
};

export type { Note };
