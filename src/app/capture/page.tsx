import { CapturePage } from "@/components/capture-page";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Capture — Nivra",
  robots: { index: false, follow: false },
};
export default function Page() {
  return <CapturePage />;
}
