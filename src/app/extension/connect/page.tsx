import { ExtensionConnect } from "@/components/extension-connect";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Connect browser — Nivra",
  robots: { index: false, follow: false },
};
export default function Page() {
  return <ExtensionConnect />;
}
