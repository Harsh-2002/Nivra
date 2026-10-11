# Synthetic fixtures

These files contain fabricated test content, not owner data. The OCR image was authored in a browser canvas with the sample invoice text used in the tests. JPEG/WebP were exported from that image in canvas; the static GIF uses a two-color palette and valid LZW clear codes. The PDF was printed from synthetic HTML in Chromium and contains the test phrases ZX-4400 and ZX-4401.

The media fixtures are generated locally, without a sourced clip: a two-second 440 Hz sine wave and a 160×90 white video frame. FFmpeg created PCM WAV, MP3, AAC/M4A, Vorbis/Ogg, FLAC, H.264/AAC MP4 and VP9/Opus WebM variants. FFmpeg also supplies application video thumbnails; Docker includes it, and host installations need it on PATH for that feature. The test matrix also contains deliberately synthetic headers for unsupported/legacy format classification; those header-only cases do not establish playback.

The files are excluded from the standalone shipping artifact. Tests assert original-byte preservation, bounded extraction/search behavior, safe file serving and real playback of the supported media fixtures in the scoped browser run.

`passkey.ts` simulates a WebAuthn authenticator with ephemeral EC keys. Its SHA-256 digests cover the RP ID and serialized client data as required by WebAuthn, never passwords. `restored-storage.ts` checks relocated backup storage in a fresh process; its file identifier arrives as an argument rather than generated JavaScript.

`local-ai-frozen.json` preserves ten synthetic examples and recorded Arctic XS similarities from the frozen evaluation. It checks the conservative suggestion filter and protected hybrid ranking for regressions; it is not a new accuracy benchmark or evidence of human acceptance.
