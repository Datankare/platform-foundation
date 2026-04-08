import type { Metadata } from "next";
import HomeClient from "./HomeClient";

export const metadata: Metadata = {
  title: "Platform Foundation",
  description: "Platform Foundation — GenAI-native application platform",
};

export default function Home() {
  return <HomeClient />;
}
