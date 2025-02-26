import { BigNumber, BigNumberish, constants, providers } from "ethers";
import { getAddress, parseUnits } from "ethers/lib/utils";
import { cloneDeep } from "lodash";

import { Provider } from "@ethersproject/providers";
import { PercentMath, WadRayMath } from "@morpho-labs/ethers-utils/lib/maths";
import { RewardsDistributor__factory } from "@morpho-labs/morpho-ethers-contract";
import addresses from "@morpho-labs/morpho-ethers-contract/lib/addresses";

import { epochUtils } from "../ages";
import { SUBGRAPH_URL } from "../config";
import { MARKETS_UPGRADE_SNAPSHOTS, VERSION_2_TIMESTAMP } from "../constants/mechanismUpgrade";
import { maxBN, minBN, now, WAD } from "../helpers";

import { StorageService } from "./StorageService";
import { getCurrentOnChainDistribution } from "./getCurrentOnChainDistribution";
import { getEpochMarketsDistribution } from "./getEpochMarketsDistribution";
import { getUserBalances } from "./getUserBalances";
import { UserBalance } from "./graph";
import { Market } from "./graph/getGraphMarkets/markets.types";

export const getUserRewards = async (
  address: string,
  storageService: StorageService,
  blockNumber?: number,
  provider: providers.Provider = new providers.InfuraProvider(1)
) => {
  let timestampEnd = now();
  if (blockNumber) {
    const block = await provider.getBlock(blockNumber);
    timestampEnd = block.timestamp;
  }
  const userBalances = await getUserBalances(SUBGRAPH_URL(), address.toLowerCase(), blockNumber).then(
    (u) => u?.balances ?? []
  );
  const currentEpoch = await epochUtils.timestampToEpoch(timestampEnd);
  const prevEpoch = await epochUtils.epochsBefore(currentEpoch.id, false).then((e) => e[e.length - 1]);
  // preload to cache the current epoch configuration
  await getEpochMarketsDistribution(currentEpoch.id, provider, storageService);

  // to prevent parallel fetching of the same data
  const marketsRewards = await userBalancesToUnclaimedTokens(userBalances, timestampEnd, provider, storageService);
  const currentRewards = sumRewards(marketsRewards);
  const onChainDistribution = await getCurrentOnChainDistribution(provider, storageService, blockNumber);
  const claimableRaw = onChainDistribution.proofs[address.toLowerCase()];
  const claimable = claimableRaw ? BigNumber.from(claimableRaw.amount) : BigNumber.from(0);
  let claimableSoon = BigNumber.from(0);

  if (prevEpoch && prevEpoch.id !== onChainDistribution.epochId) {
    // The previous epoch is done, but the root is not yet modified on chain
    // So The difference between the amùount of the previous epoch and the amount claimable on chain will be claimable soon,
    // When the root will be updated by DAO
    const prevId = prevEpoch.id;
    const prevDistribution = await storageService.readProofs(prevId);
    if (!prevDistribution) throw new Error("Previous Distribution not found");
    const claimableSoonRaw = prevDistribution.proofs[address.toLowerCase()];
    if (claimableSoonRaw) {
      claimableSoon = BigNumber.from(claimableSoonRaw.amount).sub(claimable);
    }
  }
  const currentEpochRewards = currentRewards.sub(claimable).sub(claimableSoon);

  let currentEpochProjectedRewards = currentRewards;
  if (currentEpoch?.finalTimestamp)
    currentEpochProjectedRewards = sumRewards(
      await userBalancesToUnclaimedTokens(userBalances, currentEpoch.finalTimestamp, provider, storageService)
    )
      .sub(claimable)
      .sub(claimableSoon);

  let claimed = BigNumber.from(0);
  let claimData = {};
  if (claimable.gt(0)) {
    const rewardsDisributor = RewardsDistributor__factory.connect(addresses.morphoDao.rewardsDistributor, provider);
    claimed = await rewardsDisributor.claimed(address);
    claimData = claimable.sub(claimed).gt(0)
      ? {
          root: onChainDistribution.root,
          rewardsDistributor: rewardsDisributor.address,
          functionSignature: "claim(address,uint256,bytes32[])",
          args: {
            address,
            amount: claimableRaw!.amount,
            proof: claimableRaw!.proof,
          },
          encodedData: await rewardsDisributor.populateTransaction
            .claim(address, claimableRaw!.amount, claimableRaw!.proof)
            .then((r) => r.data),
        }
      : {};
  }
  return {
    currentEpochRewards,
    currentEpochProjectedRewards,
    totalRewardsEarned: currentRewards,
    claimable,
    claimableSoon,
    claimedRewards: claimed,
    claimData,
    markets: Object.fromEntries(marketsRewards.map(({ market, ...rewards }) => [market.address, rewards])),
  };
};

export interface MarketRewards {
  market: Market;
  accumulatedSupplyV1: BigNumber;
  accumulatedSupplyV2: BigNumber;
  accumulatedSupply: BigNumber;
  accumulatedBorrowV1: BigNumber;
  accumulatedBorrowV2: BigNumber;
  accumulatedBorrow: BigNumber;
}

export const userBalancesToUnclaimedTokens = async (
  balances: UserBalance[],
  currentTimestamp: BigNumberish,
  provider: providers.Provider,
  storageService: StorageService
): Promise<MarketRewards[]> => {
  const ts = BigNumber.from(currentTimestamp);
  return Promise.all(
    balances.map(async (b) => {
      let balance = cloneDeep(b);
      let accumulatedSupplyV1 = b.accumulatedSupplyMorphoV1;
      let accumulatedSupplyV2 = b.accumulatedSupplyMorphoV2;
      let accumulatedSupply = b.accumulatedSupplyMorpho;
      if (b.market.supplyUpdateBlockTimestamp.lt(VERSION_2_TIMESTAMP) && ts.gte(VERSION_2_TIMESTAMP)) {
        // compute twice when upgrading to v2 distribution mechanism
        const { updatedBalance, accruedSupplyV1, accruedSupplyV2 } = await accrueSupplyRewards(
          b,
          VERSION_2_TIMESTAMP,
          provider,
          storageService
        );
        accumulatedSupplyV1 = accumulatedSupplyV1.add(accruedSupplyV1);
        accumulatedSupplyV2 = accumulatedSupplyV2.add(accruedSupplyV2);
        accumulatedSupply = accumulatedSupply.add(accruedSupplyV1);
        balance = updatedBalance;
      }
      if (b.timestamp.lt(VERSION_2_TIMESTAMP) && b.market.supplyUpdateBlockTimestamp.gte(VERSION_2_TIMESTAMP)) {
        const snapshot = MARKETS_UPGRADE_SNAPSHOTS.find((s: any) => s.id === b.market.address + "-supply") as any;
        if (!snapshot) throw Error(`No snapshot for market ${b.market.address} on supply side`);
        const accruedSupplyV1 = getUserAccumulatedRewards(
          BigNumber.from(snapshot.indexV1),
          b.userSupplyIndex,
          b.underlyingSupplyBalance
        );
        const accruedSupplyV2 = getUserAccumulatedRewards(
          BigNumber.from(snapshot.poolIndex),
          b.userSupplyOnPoolIndex,
          b.scaledSupplyOnPool
        ).add(
          getUserAccumulatedRewards(BigNumber.from(snapshot.p2pIndex), b.userSupplyInP2PIndex, b.scaledSupplyInP2P)
        );
        accumulatedSupplyV1 = accumulatedSupplyV1.add(accruedSupplyV1);
        accumulatedSupplyV2 = accumulatedSupplyV2.add(accruedSupplyV2);
        accumulatedSupply = accumulatedSupply.add(accruedSupplyV1);
        balance.userSupplyInP2PIndex = BigNumber.from(snapshot.p2pIndex);
        balance.userSupplyOnPoolIndex = BigNumber.from(snapshot.poolIndex);
        balance.userSupplyIndex = BigNumber.from(snapshot.indexV1);
      }

      const { accruedSupplyV1, accruedSupplyV2 } = await accrueSupplyRewards(balance, ts, provider, storageService);

      accumulatedSupplyV1 = accumulatedSupplyV1.add(accruedSupplyV1);
      accumulatedSupplyV2 = accumulatedSupplyV2.add(accruedSupplyV2);
      if (ts.gt(VERSION_2_TIMESTAMP)) accumulatedSupply = accumulatedSupply.add(accruedSupplyV2);
      else accumulatedSupply = accumulatedSupply.add(accruedSupplyV1);

      // BORROW SIDE

      let accumulatedBorrowV1 = b.accumulatedBorrowMorphoV1;
      let accumulatedBorrowV2 = b.accumulatedBorrowMorphoV2;
      let accumulatedBorrow = b.accumulatedBorrowMorpho;

      if (b.market.borrowUpdateBlockTimestamp.lt(VERSION_2_TIMESTAMP) && ts.gte(VERSION_2_TIMESTAMP)) {
        // compute twice when upgrading to v2 distribution mechanism

        const { updatedBalance, accruedBorrowV1, accruedBorrowV2 } = await accrueBorrowRewards(
          balance,
          VERSION_2_TIMESTAMP,
          provider,
          storageService
        );
        accumulatedBorrowV1 = accumulatedBorrowV1.add(accruedBorrowV1);
        accumulatedBorrowV2 = accumulatedBorrowV2.add(accruedBorrowV2);
        accumulatedBorrow = accumulatedBorrow.add(accruedBorrowV1);
        balance = updatedBalance;
      }
      if (b.timestamp.lt(VERSION_2_TIMESTAMP) && b.market.borrowUpdateBlockTimestamp.gte(VERSION_2_TIMESTAMP)) {
        const snapshot = MARKETS_UPGRADE_SNAPSHOTS.find((s: any) => s.id === b.market.address + "-borrow") as any;
        if (!snapshot) throw Error(`No snapshot for market ${b.market.address} on borrow side`);

        const accruedBorrowV1 = getUserAccumulatedRewards(
          BigNumber.from(snapshot.indexV1),
          b.userBorrowIndex,
          b.underlyingBorrowBalance
        );
        const accruedBorrowV2 = getUserAccumulatedRewards(
          BigNumber.from(snapshot.poolIndex),
          b.userBorrowOnPoolIndex,
          b.scaledBorrowOnPool
        ).add(
          getUserAccumulatedRewards(BigNumber.from(snapshot.p2pIndex), b.userBorrowInP2PIndex, b.scaledBorrowInP2P)
        );
        accumulatedBorrowV1 = accumulatedBorrowV1.add(accruedBorrowV1);
        accumulatedBorrowV2 = accumulatedBorrowV2.add(accruedBorrowV2);
        accumulatedBorrow = accumulatedBorrow.add(accruedBorrowV1);
        balance.userBorrowInP2PIndex = BigNumber.from(snapshot.p2pIndex);
        balance.userBorrowOnPoolIndex = BigNumber.from(snapshot.poolIndex);
        balance.userBorrowIndex = BigNumber.from(snapshot.indexV1);
      }

      const { accruedBorrowV1, accruedBorrowV2 } = await accrueBorrowRewards(balance, ts, provider, storageService);
      accumulatedBorrowV1 = accumulatedBorrowV1.add(accruedBorrowV1);
      accumulatedBorrowV2 = accumulatedBorrowV2.add(accruedBorrowV2);

      if (ts.gt(VERSION_2_TIMESTAMP)) accumulatedBorrow = accumulatedBorrow.add(accruedBorrowV2);
      else accumulatedBorrow = accumulatedBorrow.add(accruedBorrowV1);

      return {
        market: b.market,
        accumulatedSupplyV1,
        accumulatedSupplyV2,
        accumulatedSupply,
        accumulatedBorrowV1,
        accumulatedBorrowV2,
        accumulatedBorrow,
      };
    })
  );
};

export const sumRewards = (marketsRewards: MarketRewards[]) =>
  marketsRewards.reduce((acc, m) => acc.add(m.accumulatedBorrow.add(m.accumulatedSupply)), constants.Zero);

// last update and current timestamp must be in the same Version

/**
 * This method upgrades the market with the indexes at the given ts
 */
const accrueSupplyRewards = async (
  b: UserBalance,
  ts: BigNumber,
  provider: Provider,
  storageService: StorageService
) => {
  const supplyIndex = await computeSupplyIndex(b.market, ts, provider, storageService);
  const { p2pSupplyIndex, poolSupplyIndex } = await computeSupplyIndexes(b.market, ts, provider, storageService);
  const accruedSupplyV1 = getUserAccumulatedRewards(supplyIndex, b.userSupplyIndex, b.underlyingSupplyBalance);
  const accruedSupplyV2 = getUserAccumulatedRewards(p2pSupplyIndex, b.userSupplyInP2PIndex, b.scaledSupplyInP2P).add(
    getUserAccumulatedRewards(poolSupplyIndex, b.userSupplyOnPoolIndex, b.scaledSupplyOnPool)
  );
  // update the market
  const updatedBalance = cloneDeep(b);
  updatedBalance.market.p2pSupplyIndex = p2pSupplyIndex;
  updatedBalance.market.poolSupplyIndex = poolSupplyIndex;
  updatedBalance.market.supplyIndex = supplyIndex;
  updatedBalance.market.supplyUpdateBlockTimestamp = ts;
  updatedBalance.market.supplyUpdateBlockTimestampV1 = ts;
  updatedBalance.userSupplyOnPoolIndex = poolSupplyIndex;
  updatedBalance.userSupplyInP2PIndex = p2pSupplyIndex;
  updatedBalance.userSupplyIndex = supplyIndex;
  return { updatedBalance, accruedSupplyV1, accruedSupplyV2 };
};

/**
 * This method upgrades the market with the indexes at the given ts
 */
const accrueBorrowRewards = async (
  b: UserBalance,
  ts: BigNumber,
  provider: Provider,
  storageService: StorageService
) => {
  const borrowIndex = await computeBorrowIndex(b.market, ts, provider, storageService);
  const { p2pBorrowIndex, poolBorrowIndex } = await computeBorrowIndexes(b.market, ts, provider, storageService);
  const accruedBorrowV1 = getUserAccumulatedRewards(borrowIndex, b.userBorrowIndex, b.underlyingBorrowBalance);
  const accruedBorrowV2 = getUserAccumulatedRewards(p2pBorrowIndex, b.userBorrowInP2PIndex, b.scaledBorrowInP2P).add(
    getUserAccumulatedRewards(poolBorrowIndex, b.userBorrowOnPoolIndex, b.scaledBorrowOnPool)
  );
  // update the market
  const updatedBalance = cloneDeep(b);
  updatedBalance.market.p2pBorrowIndex = p2pBorrowIndex;
  updatedBalance.market.poolBorrowIndex = poolBorrowIndex;
  updatedBalance.market.borrowIndex = borrowIndex;
  updatedBalance.market.borrowUpdateBlockTimestamp = ts;
  updatedBalance.market.borrowUpdateBlockTimestampV1 = ts;
  updatedBalance.userBorrowOnPoolIndex = poolBorrowIndex;
  updatedBalance.userBorrowInP2PIndex = p2pBorrowIndex;
  updatedBalance.userBorrowIndex = borrowIndex;
  return { updatedBalance, accruedBorrowV1, accruedBorrowV2 };
};

const getUserAccumulatedRewards = (marketIndex: BigNumber, userIndex: BigNumber, userBalance: BigNumber) => {
  if (userIndex.gt(marketIndex)) return BigNumber.from(0);
  return marketIndex.sub(userIndex).mul(userBalance).div(WAD); // with 18 decimals
};

const computeSupplyIndex = async (
  market: Market,
  currentTimestamp: BigNumberish,
  provider: providers.Provider,
  storageService: StorageService
) =>
  computeIndex(
    storageService,
    market.address,
    market.supplyIndex,
    market.supplyUpdateBlockTimestampV1,
    currentTimestamp,
    "morphoRatePerSecondSupplySide",
    market.lastTotalSupply,
    provider
  );

const isCompound = (marketAddress: string) =>
  [
    "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643",
    "0x70e36f6BF80a52b3B46b3aF8e106CC0ed743E8e4",
    "0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5",
    "0x7713DD9Ca933848F6819F38B8352D9A15EA73F67",
    "0x35A18000230DA775CAc24873d00Ff85BccdeD550",
    "0x39AA39c021dfbaE8faC545936693aC917d5E7563",
    "0xf650C3d88D12dB855b8bf7D11Be6C55A4e07dCC9",
    "0xccF4429DB6322D5C611ee964527D42E5d685DD6a",
  ].includes(getAddress(marketAddress));

const computeSupplyIndexes = async (
  market: Market,
  currentTimestamp: BigNumberish,
  provider: providers.Provider,
  storageService: StorageService
) => {
  const rateType = "morphoRatePerSecondSupplySide";
  const marketAddress = market.address;

  // even if the index is in RAY for Morpho-Aave markets, this is not a big deal since we are using the proportion
  // between p2p and pool volumes
  const totalSupplyP2P = market.scaledSupplyInP2P
    .mul(market.lastP2PSupplyIndex)
    .div(isCompound(market.address) ? WadRayMath.WAD : WadRayMath.RAY);
  const totalSupplyOnPool = market.scaledSupplyOnPool
    .mul(market.lastPoolSupplyIndex)
    .div(isCompound(market.address) ? WadRayMath.WAD : WadRayMath.RAY);
  const totalSupply = totalSupplyOnPool.add(totalSupplyP2P);
  const lastPercentSpeed = totalSupply.isZero()
    ? constants.Zero
    : totalSupplyP2P.mul(PercentMath.BASE_PERCENT).div(totalSupply);
  return {
    p2pSupplyIndex: await computeIndex(
      storageService,
      marketAddress,
      market.p2pSupplyIndex,
      market.supplyUpdateBlockTimestamp,
      currentTimestamp,
      rateType,
      market.scaledSupplyInP2P,
      provider,
      (emission) => PercentMath.percentMul(emission, lastPercentSpeed)
    ),
    poolSupplyIndex: await computeIndex(
      storageService,
      marketAddress,
      market.poolSupplyIndex,
      market.supplyUpdateBlockTimestamp,
      currentTimestamp,
      rateType,
      market.scaledSupplyOnPool,
      provider,
      (emission) => PercentMath.percentMul(emission, PercentMath.BASE_PERCENT.sub(lastPercentSpeed))
    ),
  };
};

const computeBorrowIndex = async (
  market: Market,
  currentTimestamp: BigNumberish,
  provider: providers.Provider,
  storageService: StorageService
) =>
  computeIndex(
    storageService,
    market.address,
    market.borrowIndex,
    market.borrowUpdateBlockTimestampV1,
    currentTimestamp,
    "morphoRatePerSecondBorrowSide",
    market.lastTotalBorrow,
    provider
  );

const computeBorrowIndexes = async (
  market: Market,
  currentTimestamp: BigNumberish,
  provider: providers.Provider,
  storageService: StorageService
) => {
  const rateType = "morphoRatePerSecondBorrowSide";
  const marketAddress = market.address;

  const totalBorrowP2P = WadRayMath.wadMul(market.scaledBorrowInP2P, market.lastP2PBorrowIndex);
  const totalBorrowOnPool = WadRayMath.wadMul(market.scaledBorrowOnPool, market.lastPoolBorrowIndex);
  const totalBorrow = totalBorrowOnPool.add(totalBorrowP2P);
  const lastPercentSpeed = totalBorrow.isZero()
    ? constants.Zero
    : totalBorrowP2P.mul(PercentMath.BASE_PERCENT).div(totalBorrow);
  return {
    p2pBorrowIndex: await computeIndex(
      storageService,
      marketAddress,
      market.p2pBorrowIndex,
      market.borrowUpdateBlockTimestamp,
      currentTimestamp,
      rateType,
      market.scaledBorrowInP2P,
      provider,
      (emission) => PercentMath.percentMul(emission, lastPercentSpeed)
    ),
    poolBorrowIndex: await computeIndex(
      storageService,
      marketAddress,
      market.poolBorrowIndex,
      market.borrowUpdateBlockTimestamp,
      currentTimestamp,
      rateType,
      market.scaledBorrowOnPool,
      provider,
      (emission) => PercentMath.percentMul(emission, PercentMath.BASE_PERCENT.sub(lastPercentSpeed))
    ),
  };
};

const computeIndex = async (
  storageService: StorageService,
  marketAddress: string,
  lastIndex: BigNumber,
  lastUpdateTimestamp: BigNumberish,
  currentTimestamp: BigNumberish,
  rateType: "morphoRatePerSecondBorrowSide" | "morphoRatePerSecondSupplySide",
  totalUnderlying: BigNumber,
  provider: providers.Provider,
  speed: (emission: BigNumber) => BigNumber = (e) => e
) => {
  const epochs = await epochUtils.epochsBetweenTimestamps(
    BigNumber.from(lastUpdateTimestamp).toNumber(),
    BigNumber.from(currentTimestamp).toNumber()
  );
  // we first compute distribution of each epoch
  const distributions = Object.fromEntries(
    await Promise.all(
      epochs.map(async (epoch) => [epoch.id, await getEpochMarketsDistribution(epoch.id, provider, storageService)])
    )
  );
  return epochs.reduce((currentIndex, epoch) => {
    const initialTimestamp = maxBN(BigNumber.from(epoch.initialTimestamp), BigNumber.from(lastUpdateTimestamp));
    const finalTimestamp = minBN(BigNumber.from(epoch.finalTimestamp), BigNumber.from(currentTimestamp));
    const deltaTimestamp = finalTimestamp.sub(initialTimestamp);
    const marketsEmission = distributions[epoch.id];
    const emission = parseUnits(marketsEmission.markets[marketAddress]?.[rateType] ?? "0");
    const morphoAccrued = deltaTimestamp.mul(speed(emission)); // in WEI units;
    const ratio = totalUnderlying.isZero() ? constants.Zero : morphoAccrued.mul(WAD).div(totalUnderlying); // in 18*2 - decimals units;
    return currentIndex.add(ratio);
  }, lastIndex);
};

export { computeIndex, computeSupplyIndex, computeSupplyIndexes, computeBorrowIndex, computeBorrowIndexes };
