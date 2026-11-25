#!/usr/bin/env node
/**
 * CLI : dnd-dom-extract <export-tampermonkey.json> [-o sortie.json]
 * Analyse l'unique export Tampermonkey (responses[] + domHtml) et écrit le JSON.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { extractCharacter } from "./index.js";

interface ParsedArgs {
  inputs: string[];
  output: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { inputs: [], output: null, help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "-o":
      case "--output":
        args.output = rest[++i];
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
  -h, --help               Affiche cette aide
`;

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

  const character = extractCharacter(source, inputPath);
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
