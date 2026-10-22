import type { Abi, Hex } from "viem";
// Copy this file from your Foundry project: out/Escrow.sol/Escrow.json  ->  lib/Escrow.json
import artifact from "./Escrow.json";

export const escrowAbi = artifact.abi as unknown as Abi;
export const escrowBytecode = artifact.bytecode.object as Hex;
