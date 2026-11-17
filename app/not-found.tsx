/**
 * app/not-found.tsx — an address the app does not have (TASK-224, SF-app-004)
 *
 * The framework's default was an English "404 | This page could not be found." on a white page.
 * Now the app's own page, in the catalogue's words, with the way home.
 */

import type { Metadata } from "next";
import { ProblemPage } from "@/components/app/ui/ProblemPage";
import { renderMessage } from "@/platform/errors/messages";

export const metadata: Metadata = {
  title: renderMessage("screens.error_boundary.not_found_title"),
};

export default function NotFound() {
  return (
    <ProblemPage
      title={renderMessage("screens.error_boundary.not_found_title")}
      body={renderMessage("screens.error_boundary.not_found_body")}
    />
  );
}
