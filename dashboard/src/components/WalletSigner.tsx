// Wallet mode of the signer: the owner and the risk manager sign from their own wallet through Reown AppKit.
// Loaded lazily, only when there is no dev server and a Reown project id is set.
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { OptionsController } from "@reown/appkit-controllers";
import { sepolia as sepoliaNetwork } from "@reown/appkit/networks";
import { createAppKit, useAppKit } from "@reown/appkit/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { http, zeroAddress, type Abi, type Address } from "viem";
import { sepolia } from "viem/chains";
import { WagmiProvider, useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import {
  cutCall,
  deployedResolver,
  fundCalls,
  FUND_AMOUNT,
  grantRiskManagerCall,
  issueCalls,
  liveResolver,
  registryWriteAbi,
  forbiddenCalls,
  forbiddenOutcome,
  slippageCall,
  tightenCall,
  type LeashTarget,
} from "../lib/actions";
import { labelId, shortHex, type Deployments } from "../lib/leash";
import {
  SEPOLIA_TX_URL,
  SignerValue,
  issuedOutcome,
  ttlSeconds,
  type RoleActions,
  type RoleGate,
} from "./signer";
import { CopyHex } from "./CopyHex";

type Props = {
  projectId: string;
  rpc: string;
  deployments: Deployments;
  label: string;
  children: ReactNode;
};

let setup: { adapter: WagmiAdapter; queryClient: QueryClient } | null = null;

/// AppKit is created once per page. Reads and receipts go through the dashboard's own RPC.
function appKit(projectId: string, rpc: string) {
  if (setup) return setup;
  // createAppKit takes `enableBaseAccount` in its types but never applies it (1.8.24), and the Base Account SDK
  // posts telemetry to cca-lite.coinbase.com on load. Set it before the adapter syncs its connectors.
  OptionsController.setEnableBaseAccount(false);
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
    // The modal's own network gate can hang on a wallet whose per-site network differs from the one it shows.
    // The wallet bar below states the reported chain and switches it instead.
    allowUnsupportedChain: true,
    // Its SDK posts telemetry on load, and the demo roles live in MetaMask-like wallets.
    enableCoinbase: false,
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

export default function WalletSigner(props: Props) {
  const { adapter, queryClient } = appKit(props.projectId, props.rpc);
  return (
    <WagmiProvider config={adapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletRoles {...props} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function WalletRoles({ deployments, label, children }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: sepolia.id });
  const { switchChainAsync } = useSwitchChain();
  const { open } = useAppKit();

  /// The selected agent with its own resolver, read from the registry when the action runs.
  const target = async (): Promise<LeashTarget> => {
    if (!publicClient) throw new Error("No RPC client.");
    return {
      label,
      parentName: deployments.parentName,
      registry: deployments.orgRegistry,
      resolver: await liveResolver(publicClient, deployments.orgRegistry, label),
    };
  };
  const riskManager = deployments.riskManager ?? null;
  const owner = deployments.orgOwner ?? null;
  const same = (a: string | null) => !!a && !!address && a.toLowerCase() === address.toLowerCase();
  const role = same(riskManager) ? "risk manager" : same(owner) ? "owner" : null;
  const wrongChain = isConnected && chainId !== sepolia.id;
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchToSepolia = async () => {
    setSwitchError(null);
    try {
      await switchChainAsync({ chainId: sepolia.id });
    } catch (err) {
      const e = err as { shortMessage?: string; message?: string };
      setSwitchError(e.shortMessage ?? e.message ?? String(err));
    }
  };

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

  type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };
  const send = async (call: Call) => {
    if (!walletClient || !address || !publicClient) throw new Error("Connect a wallet first.");
    if (chainId !== sepolia.id) await switchChainAsync({ chainId: sepolia.id });
    // Each builder in lib/actions returns a fully typed call; the common shape is too wide for viem's inference.
    const hash = await walletClient.writeContract({
      ...call,
      account: address,
      chain: sepolia,
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, ok: receipt.status === "success", receipt };
  };

  const actions: RoleActions = {
    tighten: async (cap) => {
      const r = await send(tightenCall(await target(), cap));
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
      for (const a of forbiddenCalls(await target(), riskManager as Address)) {
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
      const r = await send(slippageCall(await target(), bps));
      return {
        tone: r.ok ? "ok" : "bad",
        text: r.ok
          ? `Max slippage set to ${bps} bps (${Number(bps) / 100}%).`
          : "Reverted on chain.",
        txHash: r.hash,
      };
    },
    cut: async () => {
      const r = await send(
        cutCall({
          label,
          parentName: deployments.parentName,
          registry: deployments.orgRegistry,
          resolver: zeroAddress,
        }),
      );
      return {
        tone: r.ok ? "ok" : "bad",
        text: r.ok ? `${label}.${deployments.parentName} cut.` : "Reverted on chain.",
        txHash: r.hash,
      };
    },
    issue: async (form) => {
      if (!publicClient || !owner) throw new Error("No owner in the deployment record.");
      const block = await publicClient.getBlock();
      const expiry = await publicClient.readContract({
        address: deployments.orgRegistry,
        abi: registryWriteAbi,
        functionName: "getExpiry",
        args: [labelId(form.label)],
      });
      if (expiry > block.timestamp) {
        throw new Error(
          `${form.label}.${deployments.parentName} is already live. Cut it first, or pick another name.`,
        );
      }
      if (form.delegateRisk && !riskManager)
        throw new Error("No risk manager in the deployment record.");
      const calls = issueCalls(
        { parentName: deployments.parentName, registry: deployments.orgRegistry },
        {
          label: form.label,
          agent: form.agent as Address,
          owner: owner as Address,
          quote: deployments.quote as Address,
          tokens: [deployments.token0, deployments.token1] as Address[],
          capHuman: form.cap,
          maxSlippageBps: form.bps,
          ttlSeconds: ttlSeconds(form),
        },
        block.timestamp,
      );
      const deployed = await send(calls.deployResolver);
      if (!deployed.ok)
        return {
          tone: "bad",
          text: "Resolver deployment reverted on chain.",
          txHash: deployed.hash,
        };
      const resolver = deployedResolver(deployed.receipt.logs);
      const registered = await send(calls.register(resolver));
      if (!registered.ok)
        return { tone: "bad", text: "register reverted on chain.", txHash: registered.hash };
      let last = registered.hash;
      if (form.delegateRisk && riskManager) {
        const granted = await send(grantRiskManagerCall(resolver, riskManager as Address));
        if (!granted.ok)
          return {
            tone: "bad",
            text: "Risk manager grant reverted on chain.",
            txHash: granted.hash,
          };
        last = granted.hash;
      }
      return issuedOutcome(form, deployments.parentName, calls.expiry, resolver, last);
    },
    fund: async () => {
      if (!deployments.vault) throw new Error("No vault in the deployment record.");
      let last = "";
      for (const call of fundCalls(deployments.vault, [
        deployments.token0,
        deployments.token1,
      ] as Address[])) {
        const r = await send(call);
        last = r.hash;
        if (!r.ok) return { tone: "bad", text: "mint reverted on chain.", txHash: r.hash };
      }
      return {
        tone: "ok",
        text: `Vault funded with ${FUND_AMOUNT} lUSD and ${FUND_AMOUNT} lETH (test tokens).`,
        txHash: last,
      };
    },
  };

  const header = (
    <div className="wallet-bar">
      {isConnected && address && wrongChain ? (
        <p>
          Your wallet is on chain <b>{chainId ?? "unknown"}</b> for this site. Leash runs on Sepolia
          ({sepolia.id}).{switchError && <> Switch failed: {switchError}</>}
        </p>
      ) : isConnected && address ? (
        <p>
          Signing as <b>{role ?? "an account with no role"}</b> <CopyHex value={address} />
        </p>
      ) : (
        <p>Each role signs from its own wallet. Import both accounts, then switch between them.</p>
      )}
      {wrongChain ? (
        <button className="btn" onClick={() => void switchToSepolia()}>
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
    <SignerValue
      value={{
        actions,
        riskGate: gate("risk manager", riskManager),
        ownerGate: gate("owner", owner),
        riskManager,
        owner,
        walletBar: header,
        txUrl: SEPOLIA_TX_URL,
      }}
    >
      {children}
    </SignerValue>
  );
}
