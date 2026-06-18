import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(root, 'node_modules/@mysten/sui/dist/client');

const indexMjs = `export { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from "../jsonRpc/index.mjs";
import { ClientCache } from "./cache.mjs";
import { BaseClient } from "./client.mjs";
import { CoreClient } from "./core.mjs";
import { extractStatusFromEffectsBcs, formatMoveAbortMessage, parseTransactionBcs, parseTransactionEffectsBcs } from "./utils.mjs";
import { SimulationError } from "./errors.mjs";

export { BaseClient, ClientCache, CoreClient, SimulationError, extractStatusFromEffectsBcs, formatMoveAbortMessage, parseTransactionBcs, parseTransactionEffectsBcs };
`;

const indexDmts = `export { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from "../jsonRpc/index.d.mts";
export { BaseClient, ClientCache, CoreClient, SimulationError, extractStatusFromEffectsBcs, formatMoveAbortMessage, parseTransactionBcs, parseTransactionEffectsBcs } from "./client.d.mts";
`;

writeFileSync(join(clientDir, 'index.mjs'), indexMjs);
writeFileSync(join(clientDir, 'index.d.mts'), indexDmts);

console.log('Patched @mysten/sui/client for NAVI SDK compatibility');
