import { brandDescription } from "@/lib/brand";
import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nivra",
    short_name: "Nivra",
    description: brandDescription,
    start_url: "/",
    scope: "/",
    display: "standalone",
    ...{
      share_target: {
        action: "/capture/receive",
        method: "POST",
        enctype: "application/x-www-form-urlencoded",
        params: { title: "title", text: "text", url: "url" },
      },
    },
    background_color: "#ffffff",
    theme_color: "#111111",
    icons: [
      { src: "/icons/icon-192.png?v=5", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png?v=5", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/maskable-512.png?v=5",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
