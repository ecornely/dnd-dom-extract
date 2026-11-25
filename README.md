# dnd-dom-extract

Extrait un JSON de personnage D&D 5e depuis **l'unique export** du userscript
Tampermonkey (`samples/tampermonkey.js`) : un seul JSON contenant l'API et le
DOM de la fiche D&D Beyond.

Le résultat est autonome et suit un schéma maison (`src/schema.ts`), indépendant du schéma `characters/*.json` de `dnd-beyond-extract`.

## Philosophie

- **Parsing minimal et incrémental** : seules les zones calibrées sur des exemples réels (`samples/`) sont parsées. Le reste reste vide : jamais de 0 par erreur.
- **Le DOM pour le calculé, l'API pour le brut** : la page recalcule scores, saves, skills, CA… donc ils sont pris côté DOM par ancres textuelles ; l'API fournit les données brutes fiables (identité, apparence, notes, inventaire, sorts).
- **Texte, pas CSS** : les classes CSS de D&D Beyond sont dynamiques (anti-parsing). L'extraction DOM se base sur le flux de texte (ordre document, aria-labels inclus) et des ancres humaines : l'ancre `"Strength"` est suivie de `"str"`, du signe, du modificateur puis du score.
- **Fusion sans écrasement** : le champ rempli par une source (API ou DOM) n'est jamais écrasé par l'autre ; pour les valeurs calculées, le DOM prime.

## L'export Tampermonkey (seul format supporté)

Sur une fiche personnage D&D Beyond, le userscript intercepte les réponses de
`character-service.dndbeyond.com` et capture le DOM au moment de l'export :

- **Ctrl+Shift+C** : copie le JSON au presse-papier.
- **Ctrl+Alt+C** : télécharge le JSON (`ddb-export-<id>-<horodatage>.json`).

Dans les deux cas, le fichier est identique :

```json
{
  "exportedAt": "2025-06-01T12:00:00.000Z",
  "pageUrl": "https://www.dndbeyond.com/characters/171883241",
  "count": 3,
  "responses": [
    {
      "capturedAt": "2025-06-01T11:59:58.000Z",
      "transport": "fetch",
      "status": 200,
      "url": "https://character-service.dndbeyond.com/character/v5/character/171883241",
      "payload": { "data": { "name": "Oros Telluros", "...": "..." } }
    }
  ],
  "domHtml": "<body> ...body.outerHTML de la fiche... </body>"
}
```

| Champ | Contenu | Utilisation par l'extraction |
|---|---|---|
| `responses[]` | réponses interceptées de character-service (payload `character/v5/character/<id>`, le plus volumineux, fait foi) | données brutes : identité, classe, race, apparence, notes, monnaie, inventaire, sorts, maîtrises, attaques, défenses |
| `domHtml` | `document.body.outerHTML` de la fiche | valeurs calculées : scores, saves, skills, CA, initiative, HP, vitesse, sens, maîtrises d'armes |
| `count`, `exportedAt`, `pageUrl` | métadonnées du dump | informatives |

Tout autre format est refusé avec un message d'erreur (pas de support des
anciens exports séparés v4 : JSON API seul, HTML seul, page Ctrl+S).

## Usage

```bash
nvm use                          # voir .nvmrc (v24 LTS)
npm install

npm run extract -- export.json -o personnage.json

# Via le code
import { extractCharacter } from "dnd-dom-extract";
const character = extractCharacter(jsonString, "export.json");
```

## Tests

```bash
npm test     # tsx test/extract.test.ts && tsc --noEmit
```

- `fixtures/mock-beyond-sheet.html` : fausse fiche minimaliste (JSON embarqué + ancres) ; les tests construisent un dump v5 synthétique à partir de lui.
- `samples/tampermonkey.js` : le userscript qui produit l'export.
- Les `samples/*.json` réels (regénérés avec le userscript v5) servent de vérité terrain pour étendre le mapping.

## Étendre (méthode)

1. Nouvel export Tampermonkey (Ctrl+Alt+C) → `samples/`.
2. Déboguer le flux : `tokenize(domHtml).map(t => \`${t.kind}:${t.text}\`)`.
3. Ajouter une fonction `mapXxx` ancrée sur du texte stable, jamais sur les classes.
4. Câbler dans `extractFromDom` ou `mapApiToCharacter` + assertions de vérité terrain.

À venir : parsing du tab spells DOM (casting time/DC calculés), actions, équipement détaillé.
