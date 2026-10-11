"use client";
import { useState } from "react";
import { Tags } from "lucide-react";
import type { Tag } from "@/lib/types";
import { api, apiItems } from "@/lib/client";
import { sectionCache } from "@/lib/section-cache";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function ItemTagPicker({
  type,
  id,
  title,
  disabled,
  compact = true,
  onChanged,
}: {
  type: "task" | "bookmark" | "artifact" | "event" | "form" | "response";
  id: string;
  title: string;
  disabled?: boolean;
  compact?: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setRevision(null);
    setError("");
    try {
      const [all, current] = await Promise.all([
        apiItems<Tag>("tags"),
        api<{ revision: number; tags: Tag[] }>(`item-tags/${type}/${id}`),
      ]);
      setTags(all);
      setSelected(current.tags.map((tag) => tag.id));
      setRevision(current.revision);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save() {
    if (!revision || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`item-tags/${type}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ revision, tags: selected }),
      });
      sectionCache.clear();
      await onChanged();
      window.dispatchEvent(new Event("nivra:tags-changed"));
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Popover
      modal={type === "artifact"}
      open={open}
      onOpenChange={(value) => {
        if (busy) return;
        setOpen(value);
        if (value) void load();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={compact ? "ghost" : "outline"}
          size={compact ? "icon" : "default"}
          disabled={disabled}
          aria-label={`Edit tags for ${title}`}
        >
          <Tags size={16} />
          {!compact && "Tags"}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="item-tag-picker"
        aria-label="Tags"
        align="end"
        collisionPadding={20}
        sideOffset={8}
      >
        <h2>Tags</h2>
        {error && <p role="alert">{error}</p>}
        {!revision ? (
          <>
            <p role="status">
              {error ? "Tags could not load." : "Loading tags…"}
            </p>
            {error && (
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            )}
          </>
        ) : (
          <>
            {tags.length ? (
              <div
                className="item-tag-options"
                tabIndex={0}
                role="region"
                aria-label="Available tags"
              >
                {tags.map((tag) => (
                  <label key={tag.id}>
                    <Checkbox
                      disabled={busy}
                      checked={selected.includes(tag.id)}
                      onCheckedChange={(value) =>
                        setSelected((ids) =>
                          value
                            ? [...ids, tag.id]
                            : ids.filter((id) => id !== tag.id),
                        )
                      }
                    />
                    <span className="tag-dot" data-color={tag.color} />
                    <span>{tag.name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p>Create a tag in the sidebar to organize this item.</p>
            )}
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save tags"}
            </Button>
            {error && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void load()}
              >
                Reload tags
              </Button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
