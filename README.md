# Kaam25: 13 Bhai gaadi chalayega

Drive-test ticket desk: start, end, close and share LM tickets (TechInsights, ActixOne,
WhatsApp, TEMS) from one web page.

## 1. Install Python

Get **Python 3.10+** from https://www.python.org/downloads/ and tick **"Add python.exe to PATH"**
in the installer.

## 2. Run it

**Easy way:** double-click **`runWeb.bat`**. That's it.
The first time it sets itself up and opens `.env` in Notepad - fill in your values, save,
and double-click `runWeb.bat` again. The app opens at http://127.0.0.1:5000.
Keep its window open while you work; close it to stop.

**Or in a terminal** (in this folder):

```bash
python -m venv venv
```

```bash
venv\Scripts\activate
```

```bash
pip install -r requirements.txt
```

```bash
copy .env.example .env
```

```bash
python -m web.server
```

Fill in `.env` before the last command.

## 3. Chrome extension (once)

`chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the
`chromeExtension` folder.

## Notes

- Settings live in `.env` (see `.env.example`).
- Your records (`tickets.json`), `backups/`, `maps/` and logs stay on your PC - they're not in git.
