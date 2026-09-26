// Wallet mode of the role cards: the owner and the risk manager sign from their own wallet through Reown
// AppKit. Loaded lazily, only when there is no dev server and a Reown project id is set.
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { sepolia as sepoliaNetwork } from "@reown/appkit/networks";
import { createAppKit, useAppKit } from "@reown/appkit/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, type Address } from "viem";
import { sepolia } from "viem/chains";
import { WagmiProvider, useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import {
  cutCall,
  forbiddenCalls,
  forbiddenOutcome,
  slippageCall,
  tightenCall,
  type LeashTarget,
} from "../lib/actions";
import { shortHex, type Deployments } from "../lib/leash";
import { RoleCards, type RoleActions, type RoleGate } from "./Controls";

const TX_URL = "https://sepolia.etherscan.io/tx/";

type Props = {
  projectId: string;
  rpc: string;
  deployments: Deployments;
  label: string;
  revoked: boolean;
  onChanged: () => void;
};

let setup: { adapter: WagmiAdapter; queryClient: QueryClient } | null = null;

/// AppKit is created once per page. Reads and receipts go through the dashboard's own RPC.
function appKit(projectId: string, rpc: string) {
  if (setup) return setup;
  const adapter = new WagmiAdapter({
    networks: [sepoliaNetwork],
    projectId,
    transports: { [sepoliaNetwork.id]: http(rpc) },
  });
  createAppKit({
    adapters: [adapter],
    networks: [sepoliaNetwork],
    defaultNetwork: sepoliaNetwork,
    projectId,
    metadata: {
      name: "Leash",
      description: "ENS-native permissions for autonomous traders",
      url: window.location.origin,
      icons: [],
    },
    themeMode: "light",
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
      send: false,
      receive: false,
      history: false,
    },
  });
  setup = { adapter, queryClient: new QueryClient() };
  return setup;
}

export default function WalletControls(props: Props) {
  // The wallet path signs Sepolia transactions only; a local anvil record has the dev server instead.
  if (Number(props.deployments.chainId) !== sepolia.id || !props.deployments.orgResolver)
    return null;
  const { adapter, queryClient } = appKit(props.projectId, props.rpc);
  return (
    <WagmiProvider config={adapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletRoles {...props} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function WalletRoles({ deployments, label, revoked, onChanged }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: sepolia.id });
  const { switchChainAsync } = useSwitchChain();
  const { open } = useAppKit();

  const target: LeashTarget = {
    label,
    parentName: deployments.parentName,
    registry: deployments.orgRegistry,
    resolver: deployments.orgResolver as Address,
  };
  const riskManager = deployments.riskManager ?? null;
  const owner = deployments.orgOwner ?? null;
  const same = (a: string | null) => !!a && !!address && a.toLowerCase() === address.toLowerCase();
  const role = same(riskManager) ? "risk manager" : same(owner) ? "owner" : null;
  const wrongChain = isConnected && chainId !== sepolia.id;

  const gate = (name: string, account: string | null): RoleGate => {
    if (!account) return { canSign: false, reason: `No ${name} address in the deployment record.` };
    if (!isConnected) {
      return {
        canSign: false,
        reason: `Connect the ${name} wallet (${shortHex(account)}) to sign.`,
      };
    }
    if (!same(account)) {
      return {
        canSign: false,
        reason: `Switch your wallet to the ${name} account ${shortHex(account)}.`,
      };
    }
    return { canSign: true };
  };

  type Call =
    ReturnType<typeof tightenCall> | ReturnType<typeof slippageCall> | ReturnType<typeof cutCall>;
  const send = async (call: Call) => {
    if (!walletClient || !address || !publicClient) throw new Error("Connect a wallet first.");
    if (chainId !== sepolia.id) await switchChainAsync({ chainId: sepolia.id });
    // The union of three typed calls is too wide for viem's inference, each one is valid on its own.
    const hash = await walletClient.writeContract({
      ...call,
      account: address,
      chain: sepolia,
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, ok: receipt.status === "success" };
  };

  const actions: RoleActions = {
    tighten: async (cap) => {
      const r = await send(tightenCall(target, cap));
      return {
        tone: r.ok ? "ok" : "bad",
        text: r.ok ? `Cap set to ${cap} lUSD.` : "Reverted on chain.",
        txHash: r.hash,
      };
    },
    // A simulation from the risk manager's address: no signature, anyone can run the proof.
    forbid: async () => {
      if (!publicClient || !riskManager)
        throw new Error("No risk manager in the deployment record.");
      const results = [];
      for (const a of forbiddenCalls(target, riskManager as Address)) {
        try {
          await publicClient.simulateContract({
            ...a.call,
            account: riskManager as Address,
          } as never);
          results.push(forbiddenOutcome(a.what, null));
        } catch (err) {
          results.push(forbiddenOutcome(a.what, err));
        }
      }
      return {
        tone: results.every((x) => x.ok) ? "ok" : "bad",
        text: results.map((x) => x.text).join(" · "),
      };
    },
    slippage: async (bps) => {
      const r = await send(slippageCall(target, bps));
      return {
        tone: r.ok ? "ok" : "bad",
        text: r.ok
          ? `Max slippage set to ${bps} bps (${Number(bps) / 100}%).`
          : "Reverted on chain.",
        txHash: r.hash,
      };
    },
    cut: async () => {
      const r = await send(cutCall(target));
      return {
        tone: r.ok ? "ok" : "bad",
        text: r.ok ? `${label}.${deployments.parentName} cut.` : "Reverted on chain.",
        txHash: r.hash,
      };
    },
  };

  const header = (
    <div className="wallet-bar">
      {isConnected && address ? (
        <p>
          Signing as <b>{role ?? "an account with no role"}</b>{" "}
          <span className="addr" title={address}>
            {shortHex(address)}
          </span>
        </p>
      ) : (
        <p>Each role signs from its own wallet. Import both accounts, then switch between them.</p>
      )}
      {wrongChain ? (
        <button className="btn" onClick={() => void switchChainAsync({ chainId: sepolia.id })}>
          Switch to Sepolia
        </button>
      ) : (
        <button
          className={isConnected ? "ghost small" : "btn"}
          onClick={() => void open(isConnected ? { view: "Account" } : undefined)}
        >
          {isConnected ? "Wallet" : "Connect wallet"}
        </button>
      )}
    </div>
  );

  return (
    <RoleCards
      actions={actions}
      riskManager={riskManager}
      owner={owner}
      riskGate={gate("risk manager", riskManager)}
      ownerGate={gate("owner", owner)}
      revoked={revoked}
      onChanged={onChanged}
      header={header}
      txUrl={TX_URL}
    />
  );
}
