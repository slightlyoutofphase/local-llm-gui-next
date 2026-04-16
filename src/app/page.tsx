import type { ReactElement } from "react";
import { ChatApp } from "@/components/ChatApp";

/**
 * Renders the single-page application entry route.
 *
 * @returns The Local LLM GUI shell.
 */
export default function HomePage(): ReactElement {
  return <ChatApp />;
}
