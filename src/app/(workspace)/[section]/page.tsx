import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { workspacePageState } from "@/lib/server/workspace-page";
import { installationUrl } from "@/lib/server/installation";
import { Nivra } from "@/components/nivra";
import {
  workspaceView,
  workspaceRoutes,
  workspaceSurfaces,
  workspaceSurface,
} from "@/lib/workspace-routes";
export const dynamicParams = false;
export function generateStaticParams() {
  return [
    ...Object.values(workspaceRoutes),
    ...workspaceSurfaces.map((surface) => `/${surface}`),
  ].map((path) => ({
    section: path.slice(1),
  }));
}
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { section } = await params;
  const view = workspaceView(`/${section}`);
  if (!view && !workspaceSurface(`/${section}`)) notFound();
  const state = await workspacePageState(
    new Request(
      new URL(`/${section}`, installationUrl() || "http://localhost:3000"),
      {
        headers: await headers(),
      },
    ),
    await searchParams,
  );
  if (state === "missing") notFound();
  if (state === "login") redirect("/");
  return <Nivra initialView={view ?? "overview"} signedIn />;
}
