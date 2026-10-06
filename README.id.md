<div align="center">

# claude-codex-mcp

**Biarkan Claude mendelegasikan kerja ke OpenAI Codex — tugas coding, second opinion, dan aset gambar — memakai langganan ChatGPT/Codex yang sudah kamu bayar.**

[English](README.md) · [Bahasa Indonesia](README.id.md)

</div>

`claude-codex-mcp` adalah MCP server kecil yang menjalankan **Codex CLI resmi** (`codex exec`) di komputermu. Claude mendapat lima tool: delegasi tugas, membuat gambar dengan `image_gen` bawaan Codex, memantau/membatalkan job, dan melihat daftar model. Tanpa API key OpenAI, tanpa mengambil token, tanpa layanan pihak ketiga — hanya CLI yang sudah kamu login.

Jalan di **Claude Desktop** (Chat dan Cowork) dan **Claude Code**, dan dibangun dengan Windows sebagai prioritas.

## Fitur

- **Delegasi** — `codex_task` menjalankan agen Codex di folder pilihanmu, mengembalikan pesan akhir dan `session_id` untuk melanjutkan thread Codex yang sama.
- **Aset gambar** — `codex_image` memakai GPT Image bawaan Codex, menyalin hasil ke proyekmu (tidak pernah menimpa file), mendukung latar transparan dan gambar referensi, dan mengirim preview ke Claude.
- **Pilih model** — `codex_models` membaca katalog live akunmu; atur `model` dan `reasoning_effort` (`low` … `ultra`) per panggilan.
- **Tidak memblokir** — panggilan menunggu sampai `wait_seconds` (default 50 dtk) lalu memberi `job_id`; job gambar diantrikan supaya hasil tidak tertukar.
- **Aman secara default** — sandbox `workspace-write` atau `read-only`, network mati kecuali diminta, tanpa mode full-access. Prompt lewat stdin, tidak pernah lewat shell.
- **Nol dependency runtime** — cukup Node ≥ 20.

## Kebutuhan

- Node.js 20+
- Codex CLI yang sudah login: `npm i -g @openai/codex` (atau CLI bawaan aplikasi Codex), lalu `codex login`
- Paket ChatGPT yang mencakup Codex. Pemakaian dihitung ke kuota Codex; gambar lebih cepat menghabiskan kuota daripada teks.

## Instalasi

**Claude Code (plugin):**

```text
/plugin marketplace add aikazu/claude-codex-mcp
/plugin install codex-mcp@aikazu
```

**Claude Desktop / Cowork (dan Claude Code):**

```powershell
git clone https://github.com/aikazu/claude-codex-mcp.git
cd claude-codex-mcp
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

macOS / Linux: `./scripts/install.sh`. Setelah itu **Quit** Claude Desktop dari tray lalu buka lagi.

Opsi: `-AssetDir`, `-Sandbox read-only`, `-TaskModel`/`-TaskEffort` dan `-ImageModel`/`-ImageEffort` (default model bila Claude tidak menyebutkannya; tanpa ini Codex memakai `config.toml`-mu), `-DryRun`, `-Uninstall`. Cek kapan saja dengan `node src/cli.mjs --check`.

## Contoh permintaan

- "Tampilkan `codex_models`, lalu minta model terkuat review diff PR ini, read-only."
- "Delegasikan ke Codex: tambah unit test untuk `src/payments`, lalu kamu review diff-nya dan jalankan test sendiri."
- "Bikin 4 ikon koin emas transparan pakai Codex, simpan ke `assets\icons`."

Dokumentasi lengkap (tool, konfigurasi, model keamanan, perbandingan, troubleshooting) ada di [README.md](README.md).

## Lisensi

[MIT](LICENSE) © Iqbal Attila
