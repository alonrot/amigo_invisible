# Amigo Invisible

Secret Santa for the family. Same stack as `rehearsal_salsabrosos`: one `index.html`
on Netlify, a Google Apps Script web app bound to a Google Sheet, and `server.py` as
the local mirror. The page is in Spanish.

## How it works

1. Everyone opens the page, taps **+ Añadirme**, and gives a name, a 4-digit PIN and
   an optional wishlist. That creates their row in the `people` tab.
2. You run the draw from the Sheet: menu **Sorteo ▸ Hacer el sorteo**.
3. Everyone comes back, taps their name, types their PIN, and taps the gift to see
   who they give to, plus that person's wishlist.

## Latecomers

Someone who taps **+ Añadirme** after the draw is spliced into the chain: one pair
A → B becomes A → NEW → B. Only A's assignment changes.

- The script records when each person first opens their gift (`seenAt` in the `draw`
  tab) and splices next to someone who has **not** looked whenever it can. Then
  nobody notices anything.
- If everyone has already looked, A's gift shows "Ha cambiado" and the page shows a
  warning to everybody until A opens it again. If A never comes back, A buys for B,
  B gets two gifts and the latecomer gets none. That is the one way this can go wrong.
- A latecomer joining from the page has no exclusions, so they can land next to their
  own partner. To avoid that, type their row into `people` yourself (name, pin,
  exclusions) and run **Sorteo ▸ Meter a quien falte**.

## What is and isn't secret

- `doGet` returns the event, the list of **names**, whether the draw happened, and a
  count of people who need to re-check. Never a name from the draw.
- `doPost` returns one person's assignment, and only with that person's name + PIN.
- The draw is not an HTTP endpoint. It runs from the Sheet menu or the script editor.
- **There is no lockout on wrong PINs**, by choice. A 4-digit PIN stops curiosity; a
  relative with a script can try all 10,000.
- **You own the Sheet, so you can see everything**: the PINs (plain text, so you can
  read one back to an aunt who forgot hers) and the hidden `draw` tab. The guarantee
  towards you is "I won't peek", nothing stronger.
- A PIN is remembered on the phone that typed it until **Salir** is tapped. On a
  shared phone, tap Salir.

## Local dev

    python3 server.py 8000          # then open http://localhost:8000/
    python3 server.py check         # validate exclusions, draw nothing
    python3 server.py draw          # do the draw (refuses if one exists)
    python3 server.py draw --force  # redo it
    python3 server.py late          # splice in rows added by hand after the draw
    python3 server.py reset         # wipe local_data.json

State is in `local_data.json` (gitignored). Phone on the same wifi:
`http://$(ipconfig getifaddr en0):8000/`.

## Deploy

1. **Google Sheet**: new spreadsheet ▸ Extensions ▸ Apps Script ▸ paste
   `apps_script.gs` ▸ Run ▸ `setup`. Reload the Sheet to get the **Sorteo** menu.
2. Fill in the `event` tab: `nombre`, `presupuesto`, `fecha`, `organizador`, `nota`.
3. **Deploy ▸ New deployment ▸ Web app**. Execute as: *Me*. Who has access: *Anyone*
   (not "Anyone with a Google account"). Copy the `/exec` URL.
4. Paste it into `EXEC_URL` near the top of the `<script>` in `index.html`.
5. `git push`, then Netlify ▸ Add new site ▸ Import an existing project, publish
   directory `.`, no build command.
6. Test in a **private window** on a phone.

Later script changes: Deploy ▸ Manage deployments ▸ pencil ▸ Version: *New version*.
A second "New deployment" mints a new `/exec` URL and the page keeps calling the old one.

## Before the draw

- **Exclusions**: in the `people` tab, column `exclusions`, comma-separated names.
  They apply in both directions, so a couple needs it on one row only. A name that
  matches nobody stops the draw with an error naming it.
- **Sorteo ▸ Comprobar** checks everything without drawing.
- `Sorteo ▸ Repetir el sorteo` (or `forceRedraw()`) redraws for everyone; anyone who
  already looked has a stale name. Latecomers don't need it.

## Not yet tested

The Apps Script was tested against a mock spreadsheet in Node, and the page against
`server.py` in a 390px browser. Nothing has run against a real Sheet or a real
`/exec` URL yet.
