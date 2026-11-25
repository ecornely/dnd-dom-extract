#!/usr/bin/env node
/**
 * CLI : dnd-dom-extract <source1.html> [api-export.json] [-o sortie.json]
 * Analyse des pages personnage D&D Beyond et/ou exports API et écrit le JSON.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { extractCharacterFromSources } from "./index.js";

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

const USAGE = `dnd-dom-extract — extrait un personnage D&D 5e d'une ou plusieurs sources D&D Beyond

Usage:
  dnd-dom-extract <source...> [options]
  # Exemples :
  #   dnd-dom-extract page-personnage.html
  #   dnd-dom-extract export-api.json
  #   dnd-dom-extract export-api.json spells-tab.html -o oros.json

Sources : page HTML (Ctrl+S / body), export API Tampermonkey (json "responses"),
  ou page complète (JSON embarqué characters["<id>"]). Les données brutes
  viennent de l'API, les valeurs calculées (scores, saves, skills, CA...) du DOM.

Options:
  -o, --output <fichier>   Fichier JSON de sortie (défaut : stdout)
  -h, --help               Affiche cette aide
`;

export function run(argv: string[]): { code: number; output?: string } {
  const args = parseArgs(argv);
  if (args.help || args.inputs.length === 0) {
    return { code: args.help ? 0 : 1, output: USAGE };
  }

  const sources: string[] = [];
  const refs: string[] = [];
  for (const input of args.inputs) {
    const inputPath = resolve(input);
    sources.push(readFileSync(inputPath, "utf8"));
    refs.push(inputPath);
  }

  const character = extractCharacterFromSources(sources, refs);
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
