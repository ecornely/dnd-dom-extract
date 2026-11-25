/**
 * Règles de filtrage optionnelles (rules.json), sur le modèle des rules de
 * traduction de dnd-translator. Contenu versionné, absent du payload :
 * les données character-service contiennent des feats injectés par le MJ
 * (contenu de campagne/homerbew partagé, cf. Dark Bargain, Character
 * Threads, Runestones) que la feuille n'affiche pas. Le payload ne porte
 * aucun flag « entitlement » exploitable (activeSourceCategories liste
 * toutes les sources de campagne, possédées ou non) ; on filtre donc par
 * critère déclaré : source(s) de l'ouvrage ou nom exact du feat.
 */
import { readFileSync } from "node:fs";
import type { ApiExport } from "./api.js";

export interface ExtractRules {
  /** Codes de sources rule-data (sources[].name, ex. « TCMP1 ») dont les
   *  feats/additions sont écartés des « Capacités et traits ». */
  excludeFeatureSources?: string[];
  /** Noms exacts de feats écartés, quel que soit l'ouvrage. */
  excludeFeatures?: string[];
}

const EMPTY_RULES: ExtractRules = {};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !v.trim())
  ) {
    throw new Error(`rules.json : ${field} doit être une liste de chaînes non vides`);
  }
  return value as string[];
}

/** Valide un objet lu depuis rules.json (les clés sont toutes optionnelles). */
export function normalizeExtractRules(parsed: unknown): ExtractRules {
  if (!isPlainObject(parsed)) {
    throw new Error("rules.json doit contenir un objet JSON");
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "excludeFeatureSources" && key !== "excludeFeatures") {
      throw new Error(`rules.json : clé inattendue « ${key} »`);
    }
  }
  return {
    excludeFeatureSources: stringList(parsed.excludeFeatureSources, "excludeFeatureSources"),
    excludeFeatures: stringList(parsed.excludeFeatures, "excludeFeatures"),
  };
}

/** Lit et valide un fichier de règles. */
export function loadExtractRules(path: string): ExtractRules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Impossible de lire le fichier de règles ${path} : ${error instanceof Error ? error.message : error}`,
    );
  }
  return normalizeExtractRules(parsed);
}

/** Map sourceId → { name, description } depuis la réponse rule-data du dump. */
export function sourcesFromDump(apiExport: ApiExport): Map<number, { name: string | null; description: string | null }> {
  const map = new Map<number, { name: string | null; description: string | null }>();
  const ruleData = (apiExport.responses ?? []).find(
    (r) => typeof r.url === "string" && /rule-data/.test(r.url) && r.payload?.data,
  );
  const sources = (ruleData?.payload?.data as { sources?: unknown } | undefined)?.sources;
  if (!Array.isArray(sources)) return map;
  for (const s of sources) {
    if (!isPlainObject(s)) continue;
    const id = typeof s.id === "number" ? s.id : null;
    if (id === null) continue;
    map.set(id, {
      name: typeof s.name === "string" ? s.name : null,
      description: typeof s.description === "string" ? s.description : null,
    });
  }
  return map;
}

/**
 * Un feat passé-t-il les règles ? Exclu si :
 * - son nom figure dans excludeFeatures ; ou
 * - excludeFeatureSources est non vide et TOUTES les sources du feat
 *   (resolved via rule-data) sont exclues. Un feat sans source résolue
 *   passe toujours (jamais de filtre conservateur par excès).
 */
export function featureAllowed(
  def: Record<string, unknown>,
  rules: ExtractRules,
  sourcesById: Map<number, { name: string | null; description: string | null }>,
): boolean {
  const name = typeof def.name === "string" ? def.name : null;
  if (name && (rules.excludeFeatures ?? []).some((n) => n.toLowerCase() === name.toLowerCase())) {
    return false;
  }
  const excludedSources = rules.excludeFeatureSources ?? [];
  if (!name || excludedSources.length === 0) return true;
  const featsSources = Array.isArray(def.sources) ? def.sources : [];
  if (featsSources.length === 0) return true;
  for (const s of featsSources) {
    if (!isPlainObject(s) || typeof s.sourceId !== "number") return true;
    const resolved = sourcesById.get(s.sourceId);
    // Source inconnue du dump : on ne prend pas le risque d'exclure.
    if (!resolved) return true;
    const matches =
      (resolved.name !== null && excludedSources.some((n) => n.toLowerCase() === resolved.name!.toLowerCase())) ||
      (resolved.description !== null &&
        excludedSources.some((n) => n.toLowerCase() === resolved.description!.toLowerCase()));
    // Une source hors liste : le feat reste affiché.
    if (!matches) return true;
  }
  return false;
}

export { EMPTY_RULES };
