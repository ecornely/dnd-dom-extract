#!/usr/bin/env node
/**
 * CLI : dnd-dom-extract <export-tampermonkey.json> [-o sortie.json]
 * Analyse l'unique export Tampermonkey (responses[] + domHtml) et écrit le JSON.
 */
import { existsSync } from "node:fs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { extractCharacter } from "./index.js";
import { loadExtractRules, normalizeExtractRules, type ExtractRules } from "./rules.js";

/** Règles de filtrage par défaut : rules.json à la racine du projet. */
export const DEFAULT_RULES_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "rules.json");

interface ParsedArgs {
  inputs: string[];
  output: string | null;
  rules: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { inputs: [], output: null, rules: null, help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "-o":
      case "--output":
        args.output = rest[++i];
        break;
      case "--rules":
        args.rules = rest[++i];
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        args.inputs.push(rest[i]);
    }
  }
  return args;
}

const USAGE = `dnd-dom-extract — extrait un personnage D&D 5e d'un export Tampermonkey

Usage:
  dnd-dom-extract <export-tampermonkey.json> [options]
  # Exemple :
  #   dnd-dom-extract export.json -o oros.json

Source : l'unique export JSON du userscript Tampermonkey v5 —
  { exportedAt, pageUrl, count, responses[], domHtml } — copié au presse-papier
  (Ctrl+Shift+C) ou téléchargé (Ctrl+Alt+C) sur la fiche D&D Beyond.
  Les données brutes viennent des réponses character-service (responses[]),
  les valeurs calculées (scores, saves, skills, CA...) du DOM (domHtml).

Options:
  -o, --output <fichier>   Fichier JSON de sortie (défaut : stdout)
  --rules <fichier>        Règles de filtrage JSON (excludeFeatureSources /
                           excludeFeatures). Défaut : rules.json à la racine
                           du projet si présent, sinon aucun filtrage.
  -h, --help               Affiche cette aide
`;

/** Charge les règles : --rules explicite, sinon rules.json par défaut s'il
 *  existe, sinon aucun filtrage. Les règles implicites absentes ne sont pas
 *  une erreur (le filtrage est optionnel par nature). */
function loadRules(overrides: string | null): ExtractRules {
  const path = overrides ?? (existsSync(DEFAULT_RULES_PATH) ? DEFAULT_RULES_PATH : null);
  if (!path) return normalizeExtractRules({});
  return loadExtractRules(path);
}

export function run(argv: string[]): { code: number; output?: string } {
  const args = parseArgs(argv);
  if (args.help || args.inputs.length === 0) {
    return { code: args.help ? 0 : 1, output: USAGE };
  }
  if (args.inputs.length !== 1) {
    return {
      code: 1,
      output: `Un seul fichier attendu (l'export JSON Tampermonkey avec responses[] + domHtml). Reçu : ${args.inputs.join(", ")}\n`,
    };
  }

  const inputPath = resolve(args.inputs[0]);
  const source = readFileSync(inputPath, "utf8");

  const character = extractCharacter(source, inputPath, { rules: loadRules(args.rules) });
  const json = JSON.stringify(character, null, 2);

  if (args.output) {
    const outPath = resolve(args.output);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json + "\n", "utf8");
    return { code: 0, output: `Personnage « ${character.name ?? "?"} » écrit dans ${outPath}\n` };
  }
  return { code: 0, output: json };
}

// N'exécute pas ce bloc à l'import (les tests réutilisent run()).
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { code, output } = run(process.argv);
  if (output !== undefined) process.stdout.write(output);
  process.exit(code);
}
