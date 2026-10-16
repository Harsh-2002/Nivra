import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { Nivra } from "@/components/nivra";
import { formRoute } from "@/lib/workspace-routes";
import { workspacePageState } from "@/lib/server/workspace-page";
import { installationUrl } from "@/lib/server/installation";

export default async function Page({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  const pathname = `/forms/${path.join("/")}`;
  if (!formRoute(pathname)) notFound();
  const state = await workspacePageState(
    new Request(
      new URL(pathname, installationUrl() || "http://localhost:3000"),
      { headers: await headers() },
    ),
  );
  if (state === "missing") notFound();
  if (state === "login") redirect("/");
  return <Nivra initialView="forms" signedIn />;
}
