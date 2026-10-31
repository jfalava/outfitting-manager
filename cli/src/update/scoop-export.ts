import { Option, Schema } from "effect";

import { CliFailure, errorMessage } from "@/errors";

export interface ScoopExportApp {
  Name: string;
  Source: string;
  Version: string;
  Info: string;
}

export interface ScoopExportBucket {
  Name: string;
  Source: string;
}

export interface ScoopExportState {
  apps: ScoopExportApp[];
  buckets: ScoopExportBucket[];
}

const ScoopExportAppSchema = Schema.Struct({
  Name: Schema.String,
  Source: Schema.optionalKey(Schema.NullOr(Schema.String)),
  Version: Schema.String,
  Info: Schema.String,
});

const ScoopExportBucketSchema = Schema.Struct({
  Name: Schema.String,
  Source: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const ScoopExportSchema = Schema.Struct({
  apps: Schema.ArrayEnsure(ScoopExportAppSchema),
  buckets: Schema.ArrayEnsure(ScoopExportBucketSchema),
});

type DecodedScoopExport = Schema.Schema.Type<typeof ScoopExportSchema>;

const decodeScoopExport = Schema.decodeUnknownOption(ScoopExportSchema);

function normalizeScoopExport(decoded: DecodedScoopExport): ScoopExportState {
  return {
    apps: decoded.apps.map((app) => ({
      Name: app.Name,
      Source: app.Source ?? "",
      Version: app.Version,
      Info: app.Info,
    })),
    buckets: decoded.buckets.map((bucket) => ({
      Name: bucket.Name,
      Source: bucket.Source ?? "",
    })),
  };
}

/** Parse the stable JSON object emitted by `scoop export`. */
export function parseScoopExport(output: string): ScoopExportState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch (cause) {
    throw new CliFailure({
      message: `Unable to parse Scoop export: ${errorMessage(cause)}`,
      cause,
    });
  }
  const decoded = decodeScoopExport(parsed);
  if (Option.isNone(decoded)) {
    throw new CliFailure({ message: "Scoop export must contain valid apps and buckets." });
  }
  return normalizeScoopExport(decoded.value);
}
