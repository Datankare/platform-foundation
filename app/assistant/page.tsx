import type { Metadata } from "next";
import AssistantClient from "./AssistantClient";
import { renderMessage } from "@/platform/errors/messages";

export const metadata: Metadata = {
  title: renderMessage("screens.assistant.meta_title"),
};

/** The assistant (TASK-211, N-118): a signed-in user's question, its answer streamed. */
export default function AssistantPage() {
  return <AssistantClient />;
}
