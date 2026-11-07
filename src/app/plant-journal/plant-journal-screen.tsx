"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FigmaIcon } from "../app-shell";
import { getLevelProgress, useQuestStore } from "../quest-store";
import {
  getNextPlantProgress,
  getPlantCollectionStatus,
  getPlantFilterResults,
  getPlantJournalPage,
  getPlantJournalSpread,
  getPlantThresholdProgress,
  getWaitingGiftsLabel,
  plantCatalog,
  type Plant,
  type PlantFilter,
} from "../plant-journal-logic";

function PlantCard({ plant, collected, totalXp }: { plant: Plant; collected: boolean; totalXp: number }) {
  const progress = getPlantThresholdProgress(plant, totalXp);

  return (
    <article className={`journal-plant-card${collected ? " is-collected" : " is-locked"}`}>
      <div className="journal-plant-art">
        {plant.imageSrc ? (
          <Image
            src={plant.imageSrc}
            alt={collected ? plant.name : ""}
            aria-hidden={!collected}
            width={88}
            height={88}
            unoptimized
            className={`pixel-art journal-plant-image${collected ? "" : " is-silhouette"}`}
          />
        ) : (
          <div className="journal-plant-silhouette" aria-hidden="true">
            <FigmaIcon src="/icon-sprout.svg" size={72} />
          </div>
        )}
        <span className="journal-plant-status" aria-label={collected ? "Discovered" : "Locked"}>
          {collected ? <FigmaIcon src="/icon-check.svg" size={13} /> : <span className="journal-lock-icon" aria-hidden="true" />}
        </span>
      </div>
      <h3>{plant.name}</h3>
      {collected ? (
        <p className="journal-plant-detail">Discovered</p>
      ) : (
        <>
          <p className="journal-plant-detail">Discover at {plant.xpThreshold} XP</p>
          <div
            className="journal-plant-progress"
            role="progressbar"
            aria-label={`XP progress toward ${plant.name}`}
            aria-valuemin={0}
            aria-valuemax={Math.max(1, plant.xpThreshold)}
            aria-valuenow={Math.max(0, Math.min(totalXp, plant.xpThreshold))}
          >
            <span style={{ width: `${progress.progressPercent}%` }} />
          </div>
          <span className="journal-plant-progress-label">{progress.xpRemaining} XP to go</span>
        </>
      )}
    </article>
  );
}

/** Below this width the journal shows one page at a time. Matches `.journal-book` rules in globals.css. */
const singlePageQuery = "(max-width: 980px)";

function subscribeToSinglePage(onChange: () => void) {
  const query = window.matchMedia(singlePageQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the screen is narrow enough for one page at a time. Two-page spreads before the page is in a browser. */
function useSinglePageJournal(): boolean {
  return useSyncExternalStore(subscribeToSinglePage, () => window.matchMedia(singlePageQuery).matches, () => false);
}

/** Each page's heading and description, as in the two-page spread: left pages are odd, right pages even. */
function pageCopy(filter: PlantFilter, side: "left" | "right") {
  if (side === "left") {
    return {
      title: filter === "all" ? "Your Growing Collection" : filter === "collected" ? "Collected Plants" : "Undiscovered Plants",
      description: filter === "locked" ? "More lovely things are waiting to grow." : "The little leaves you’ve gathered.",
    };
  }
  return {
    title: filter === "all" ? "Your Collection Continues" : filter === "collected" ? "Collected Plants" : "Undiscovered Plants",
    description: filter === "collected" ? "The little leaves you’ve gathered." : "More lovely things are waiting to grow.",
  };
}

function BookPage({
  title,
  description,
  plants,
  discoveredPlantIds,
  pageKind,
  totalXp,
  pageNumber,
}: {
  title: string;
  description: string;
  plants: Plant[];
  discoveredPlantIds: string[];
  pageKind: PlantFilter;
  totalXp: number;
  pageNumber: number;
}) {
  const gridSlots = [...plants, ...Array.from({ length: Math.max(0, 4 - plants.length) }, () => null)];
  const discoveredSet = new Set(discoveredPlantIds);
  const collectedPage = pageKind === "collected" || (pageKind === "all" && pageNumber % 2 === 1);

  return (
    <section className="journal-book-page">
      <header className="journal-page-heading">
        <div className="journal-page-title">
          <h2>{title}</h2>
          <FigmaIcon src={collectedPage ? "/icon-sparkles.svg" : "/icon-book.svg"} size={18} />
        </div>
        <p>{description}</p>
      </header>
      <div className="journal-plant-grid">
        {gridSlots.map((plant, index) =>
          plant ? (
            <PlantCard key={plant.id} plant={plant} collected={discoveredSet.has(plant.id)} totalXp={totalXp} />
          ) : (
            <div
              className="journal-plant-pocket"
              key={`empty-pocket-${pageNumber}-${index}`}
              aria-hidden="true"
            />
          ),
        )}
      </div>
      <footer className="journal-page-footer">
        <span>{collectedPage ? "Every discovery is part of your story." : "Keep growing at your own pace."}</span>
        <span>Page {pageNumber}</span>
      </footer>
    </section>
  );
}

export default function PlantJournalScreen() {
  const [filter, setFilter] = useState<PlantFilter>("all");
  // The page being read (0 is page 1). Two-page spreads show the spread containing it; one page at a
  // time shows just it, so resizing keeps the reader's place.
  const [pageIndex, setPageIndex] = useState(0);
  const singlePage = useSinglePageJournal();
  const previousPageRef = useRef<HTMLButtonElement>(null);
  const nextPageRef = useRef<HTMLButtonElement>(null);
  /** After reaching the first or last page, that button is disabled, so focus moves to the other one. */
  const pendingPageFocus = useRef<"previous" | "next" | null>(null);
  const [revealedPlantId, setRevealedPlantId] = useState<string | null>(null);
  const { totalXp, discoveredPlantIds, pendingPlantGiftIds, unwrapPlantGift, hasRestored } = useQuestStore();
  const { level, xpIntoLevel, xpForNextLevel } = getLevelProgress(totalXp);
  const nextDiscovery = getNextPlantProgress(totalXp, discoveredPlantIds, pendingPlantGiftIds);
  const giftsAreLastRemaining = getPlantCollectionStatus(totalXp, discoveredPlantIds, pendingPlantGiftIds) === "gifts-waiting";
  const visiblePlants = getPlantFilterResults(discoveredPlantIds, filter, pendingPlantGiftIds);
  const discoveredSet = new Set(discoveredPlantIds);
  const collectionCount = plantCatalog.filter((plant) => discoveredSet.has(plant.id)).length;
  const spread = getPlantJournalSpread(discoveredPlantIds, filter, Math.floor(pageIndex / 2), pendingPlantGiftIds);
  const { leftPlants, rightPlants, currentSpread, spreadCount } = spread;
  const onePage = getPlantJournalPage(discoveredPlantIds, filter, pageIndex, pendingPlantGiftIds);
  const onePageCopy = pageCopy(filter, onePage.currentPage % 2 === 0 ? "left" : "right");

  useEffect(() => {
    const target = pendingPageFocus.current === "previous" ? previousPageRef.current
      : pendingPageFocus.current === "next" ? nextPageRef.current : null;
    if (!target) return;
    pendingPageFocus.current = null;
    if (!target.disabled) target.focus();
  });

  function turnPage(step: -1 | 1) {
    const next = onePage.currentPage + step;
    setPageIndex(next);
    if (next === 0) pendingPageFocus.current = "next";
    else if (next === onePage.pageCount - 1) pendingPageFocus.current = "previous";
  }
  const nextGift = plantCatalog.find((plant) => pendingPlantGiftIds.includes(plant.id));
  const revealedPlant = plantCatalog.find((plant) => plant.id === revealedPlantId);

  if (!hasRestored) {
    return <main className="journal-content"><p className="journal-loading">Opening your journal…</p></main>;
  }

  return (
    <main className="journal-content">
      <header className="journal-header">
        <div className="journal-introduction">
          <h1>Plant Journal</h1>
          <p>A little record of the plants you’ve discovered along the way.</p>
        </div>
        <div className="journal-collection-count" aria-label={`${collectionCount} of ${plantCatalog.length} plants discovered`}>
          <FigmaIcon src="/icon-sprout.svg" size={20} />
          <span className="journal-status-chip">{collectionCount} of {plantCatalog.length} discovered</span>
        </div>
      </header>

      {revealedPlant && (
        <section className="journal-starter-gift is-unwrapped" aria-live="polite">
          {revealedPlant.imageSrc ? (
              <Image
                src={revealedPlant.imageSrc}
                alt={revealedPlant.name}
                width={56}
                height={56}
                unoptimized
                className="pixel-art journal-gift-fern"
              />
          ) : (
            <div className="journal-gift-fern" aria-hidden="true"><FigmaIcon src="/icon-sprout.svg" size={40} /></div>
          )}
          <div className="journal-gift-copy">
            <strong>{revealedPlant.name} has joined your collection!</strong>
            <span>Your garden has a new friend.</span>
          </div>
        </section>
      )}

      {nextGift && (
        <section className="journal-starter-gift" aria-live="polite">
            <svg className="journal-gift-art" width={56} height={56} viewBox="0 0 32 32" role="img" aria-label="Wrapped pixel-art gift" shapeRendering="crispEdges">
              <rect x="5" y="11" width="22" height="17" fill="#b86b5a" />
              <rect x="4" y="9" width="24" height="4" fill="#d08b70" />
              <rect x="14" y="9" width="4" height="19" fill="#f2cf78" />
              <rect x="4" y="16" width="24" height="3" fill="#f2cf78" />
              <rect x="10" y="4" width="4" height="4" fill="#f2cf78" />
              <rect x="8" y="2" width="4" height="4" fill="#f2cf78" />
              <rect x="18" y="4" width="4" height="4" fill="#f2cf78" />
              <rect x="20" y="2" width="4" height="4" fill="#f2cf78" />
              <rect x="7" y="13" width="2" height="2" fill="#92533f" />
              <rect x="23" y="13" width="2" height="2" fill="#92533f" />
              <rect x="7" y="25" width="18" height="2" fill="#92533f" />
            </svg>
          <div className="journal-gift-copy">
            <strong>A little mystery gift is waiting</strong>
            <span>A new plant is tucked inside.</span>
          </div>
          <button
            className="journal-gift-button"
            type="button"
            onClick={() => {
              unwrapPlantGift(nextGift.id);
              setRevealedPlantId(nextGift.id);
            }}
          >
            Unwrap gift
          </button>
        </section>
      )}

      <section className="journal-progress-summary" aria-label="Plant collection progress">
        <div className="journal-summary-item">
          <FigmaIcon src="/icon-sprout.svg" size={24} />
          <div>
            <strong>Level {level}</strong>
            <span>{xpIntoLevel} / {xpForNextLevel} XP this level</span>
          </div>
        </div>
        <span className="journal-summary-divider" aria-hidden="true" />
        <div className="journal-summary-item">
          <FigmaIcon src="/icon-check.svg" size={22} />
          <div>
            <strong>{collectionCount} of {plantCatalog.length} plants</strong>
            <span>{totalXp} XP in your ledger</span>
          </div>
        </div>
        <span className="journal-summary-divider" aria-hidden="true" />
        <div className="journal-summary-item journal-next-discovery">
          <FigmaIcon src="/icon-sparkles.svg" size={22} />
          <div>
            <strong>{nextDiscovery ? nextDiscovery.plant.name : giftsAreLastRemaining ? getWaitingGiftsLabel(pendingPlantGiftIds.length) : "All plants discovered"}</strong>
            <span>{nextDiscovery ? `${nextDiscovery.xpRemaining} XP until discovery` : giftsAreLastRemaining ? "Ready to be unwrapped" : "Your collection is complete"}</span>
          </div>
        </div>
      </section>

      <section className="journal-tabs" aria-label="Filter plant collection">
        <div className="journal-filters" role="group" aria-label="Plant filters">
          {(["all", "collected", "locked"] as const).map((item) => (
            <button
              className={`journal-filter${filter === item ? " is-active" : ""}`}
              key={item}
              type="button"
              aria-pressed={filter === item}
              onClick={() => {
                setFilter(item);
                setPageIndex(0);
              }}
            >
              {item === "all" ? "All" : item === "collected" ? "Collected" : "Locked"}
            </button>
          ))}
        </div>
        <span className="journal-filter-count">Showing {visiblePlants.length} plants</span>
      </section>

      <section className={`journal-book${singlePage ? " is-single-page" : ""}`} aria-label="Open botanical journal">
        {singlePage ? (
          <>
            <div className="journal-book-spread">
              <BookPage
                {...onePageCopy}
                plants={onePage.plants}
                discoveredPlantIds={discoveredPlantIds}
                pageKind={filter}
                totalXp={totalXp}
                pageNumber={onePage.pageNumber}
              />
            </div>
            <nav className="journal-page-navigation" aria-label="Journal page navigation">
              <button
                ref={previousPageRef}
                type="button"
                aria-label="Previous page"
                disabled={onePage.currentPage === 0}
                onClick={() => turnPage(-1)}
              >
                <span aria-hidden="true">‹</span> Previous
              </button>
              <span className="journal-page-indicator" aria-live="polite">
                Page {onePage.pageNumber} of {onePage.pageCount}
              </span>
              <button
                ref={nextPageRef}
                type="button"
                aria-label="Next page"
                disabled={onePage.currentPage >= onePage.pageCount - 1}
                onClick={() => turnPage(1)}
              >
                Next <span aria-hidden="true">›</span>
              </button>
            </nav>
          </>
        ) : (
          <>
            <div className="journal-book-spread">
              <BookPage
                {...pageCopy(filter, "left")}
                plants={leftPlants}
                discoveredPlantIds={discoveredPlantIds}
                pageKind={filter}
                totalXp={totalXp}
                pageNumber={currentSpread * 2 + 1}
              />
              <div className="journal-book-binding" aria-hidden="true"><span /></div>
              <BookPage
                {...pageCopy(filter, "right")}
                plants={rightPlants}
                discoveredPlantIds={discoveredPlantIds}
                pageKind={filter}
                totalXp={totalXp}
                pageNumber={currentSpread * 2 + 2}
              />
            </div>
            {spreadCount > 1 && (
              <nav className="journal-book-navigation" aria-label="Journal spread navigation">
                {currentSpread > 0 && (
                  <button
                    type="button"
                    aria-label="Previous spread"
                    onClick={() => setPageIndex((currentSpread - 1) * 2)}
                  >
                    <span aria-hidden="true">←</span>
                  </button>
                )}
                {currentSpread < spreadCount - 1 && (
                  <button
                    type="button"
                    aria-label="Next spread"
                    onClick={() => setPageIndex((currentSpread + 1) * 2)}
                  >
                    <span aria-hidden="true">→</span>
                  </button>
                )}
              </nav>
            )}
          </>
        )}
      </section>

      <p className="journal-note">
        <FigmaIcon src="/icon-heart.svg" size={14} />
        <span>Every small step helps your garden grow.</span>
      </p>
    </main>
  );
}
