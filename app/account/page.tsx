import type { Metadata } from "next";
import AccountClient from "./AccountClient";
import { renderMessage } from "@/platform/errors/messages";

export const metadata: Metadata = {
  title: renderMessage("screens.account.meta_title"),
};

/** The signed-in user's account page (TASK-210): the decisions about their content, and appeals. */
export default function AccountPage() {
  return <AccountClient />;
}
