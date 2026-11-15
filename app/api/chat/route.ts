import { createChatHandler } from "@/lib/api/chat-handler";

// Vercel Hobby plan caps serverless functions at 300s; longer values fail deploy.
export const maxDuration = 300;

export const POST = createChatHandler();
