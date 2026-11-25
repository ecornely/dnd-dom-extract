# dnd-dom-extract

Extrait un JSON de personnage D&D 5e depuis des sources D&D Beyond : page enregistrée (Ctrl+S), export DOM (Tampermonkey) et export API (Tampermonkey, réponses de `character-service.dndbeyond.com`).

Le résultat est autonome et suit un schéma maison (`src/schema.ts`), indépendant du schéma `characters/*.json` de `dnd-beyond-extract`.

## Philosophie

- **Parsing minimal et incrémental** : seules les zones calibrées sur des exemples réels (`samples/`) sont parsées. Le reste reste vide : jamais de 0 par erreur.
- **Le DOM pour le calculé, l'API pour le brut** : la page recalcule scores, saves, skills, CA… donc ils sont pris côté DOM par ancres textuelles ; l'API fournit les données brutes fiables (identité, apparence, notes, inventaire, sorts).
- **Texte, pas CSS** : les classes CSS de D&D Beyond sont dynamiques (anti-parsing). L'extraction DOM se base sur le flux de texte (ordre document, aria-labels inclus) et des ancres humaines : l'ancre `"Strength"` est suivie de `"str"`, du signe, du modificateur puis du score.
- **Fusion sans écrasement** : multi-sources, un champ rempli n'est jamais écrasé.

## Sources (auto-détectées)

| Source | Contenu | Points forts |
|---|---|---|
| `export-api.json` (Tampermonkey Ctrl+Shift+C) | `responses[]` de character-service | identité, apparence, notes, inventaire, sorts, pièces |
| `page.html` / `body.outerHTML` (Ctrl+Alt+C) | DOM visible | valeurs calculées : scores, saves, skills, CA, initiative, HP, vitesse, sens, maîtrises |
| page complète Ctrl+S | JSON embarqué `characters["<id>"]` | tout (canal historique) |

## Usage

```bash
nvm use                          # voir .nvmrc (v24 LTS)
npm install

# Une source
npm run extract -- page.html
npm run extract -- export-api.json -o personnage.json

# Multi-sources (recommandé) : API + DOM
npm run extract -- export-api.json spells-tab.html -o personnage.json

# Via le code
import { extractCharacterFromSources, extractCharacter } from "dnd-dom-extract";
const character = extractCharacter(htmlString, "page.html");
```

## Tests

```bash
npm test     # tsx test/extract.test.ts && tsc --noEmit
```

- `samples/oros.json` + `samples/oros-spells-tab.html` : Oros Telluros (druid 2)
- `samples/esther.json` + `samples/esther-spells-tab.html` : Esther Vaelis (sorcerer 2)
- `samples/tampermonkey.js` : le userscript qui capture l'API (Ctrl+Shift+C) et le DOM (Ctrl+Alt+C)
- `fixtures/mock-beyond-sheet.html` : fausse page minimaliste (JSON embarqué + ancres)

## Étendre (méthode)

1. Nouvel export Tampermonkey (json et/ou body) → `samples/`.
2. Déboguer le flux : `tokenize(html).map(t => \`${t.kind}:${t.text}\`)`.
3. Ajouter une fonction `mapXxx` ancrée sur du texte stable, jamais sur les classes.
4. Câbler dans `extractFromDom` ou `mapApiToCharacter` + assertions de vérité terrain.

À venir : parsing du tab spells DOM (casting time/DC calculés), actions, équipement détaillé ; export tout-en-un par Tampermonkey (onglets appendés au DOM + téléchargement json+html).
