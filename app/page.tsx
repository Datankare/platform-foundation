import type { Metadata } from "next";
import SpikeApp from "@/components/SpikeApp";

export const metadata: Metadata = {
  title: "Platform Foundation · Validation Spike v0.1",
  description:
    "Platform Foundation platform validation spike — voice and text to multilingual speech",
};

export default function Home() {
  return <SpikeApp />;
}
