/**
 * games/module.ts — The games module (ADR-054 D2)
 *
 * A placeholder until a game exists: it contributes nothing to the core yet. Listed so the
 * module manifest, the lint boundary and (Sprint 7S) the consumer sync already treat games/ as
 * a module rather than core.
 *
 * @module games
 */

import { definePlatformModule } from "@/platform/modules/define";

export const GAMES_MODULE = definePlatformModule({ id: "games" });
