import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
  type EIP1193Provider,
} from "viem";
import { CHAIN } from "./config";

/** Connects MetaMask, makes sure it is on the right network, returns viem clients. */
export async function connect() {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) {
    throw new Error("MetaMask not found. Install the MetaMask extension and refresh the page.");
  }

  const walletClient = createWalletClient({ chain: CHAIN, transport: custom(eth) });
  const [account] = await walletClient.requestAddresses();
  if (!account) throw new Error("No account selected in MetaMask.");

  if ((await walletClient.getChainId()) !== CHAIN.id) {
    try {
      await walletClient.switchChain({ id: CHAIN.id });
    } catch {
      // Network not added to MetaMask yet (e.g. local Anvil): add it, then switch.
      await walletClient.addChain({ chain: CHAIN });
      await walletClient.switchChain({ id: CHAIN.id });
    }
  }

  const publicClient = createPublicClient({ chain: CHAIN, transport: custom(eth) });
  return { walletClient, publicClient, account: account as Address };
}
