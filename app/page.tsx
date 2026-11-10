import type { Metadata } from "next";
import HomeClient from "./HomeClient";
import { renderMessage } from "@/platform/errors/messages";

export const metadata: Metadata = {
  title: renderMessage("screens.app.meta.site_title"),
  description: renderMessage("screens.app.meta.home_description"),
};

export default function Home() {
  return <HomeClient />;
}
