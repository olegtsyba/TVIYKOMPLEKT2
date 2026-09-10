import React from 'react';
import { COLOR_HEX } from '../constants';

export type SortOption = 'default' | 'price-asc' | 'price-desc';

interface CatalogFiltersProps {
  availableColors: string[];
  selectedColors: Set<string>;
  onToggleColor: (color: string) => void;
  priceBounds: [number, number];
  priceRange: [number, number];
  onChangePriceRange: (range: [number, number]) => void;
  sortOption: SortOption;
  onChangeSort: (option: SortOption) => void;
  onReset: () => void;
}

// Shared filter controls (color + price range + sort) rendered both in the
// desktop sidebar and the mobile bottom sheet - kept as one component so the
// two surfaces can't drift apart.
export default function CatalogFilters({
  availableColors,
  selectedColors,
  onToggleColor,
  priceBounds,
  priceRange,
  onChangePriceRange,
  sortOption,
  onChangeSort,
  onReset,
}: CatalogFiltersProps) {
  const [minBound, maxBound] = priceBounds;
  const [rangeMin, rangeMax] = priceRange;
  const hasBounds = maxBound > minBound;

  const handleMinChange = (value: number) => {
    onChangePriceRange([Math.min(value, rangeMax), rangeMax]);
  };
  const handleMaxChange = (value: number) => {
    onChangePriceRange([rangeMin, Math.max(value, rangeMin)]);
  };

  return (
    <div className="space-y-8">
      {/* Sort */}
      <div>
        <p className="text-xs uppercase font-bold tracking-wider mb-3">Сортування</p>
        <select
          value={sortOption}
          onChange={(e) => onChangeSort(e.target.value as SortOption)}
          className="w-full border border-gray-300 text-sm px-3 py-2 bg-white outline-none focus:border-black transition-colors"
        >
          <option value="default">За замовчуванням</option>
          <option value="price-asc">Ціна: від дешевих</option>
          <option value="price-desc">Ціна: від дорогих</option>
        </select>
      </div>

      {/* Price range */}
      <div>
        <p className="text-xs uppercase font-bold tracking-wider mb-3">Ціна</p>
        {hasBounds ? (
          <>
            <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
              <span>{rangeMin} UAH</span>
              <span>{rangeMax} UAH</span>
            </div>
            <div className="relative h-6 flex items-center">
              <div className="absolute left-0 right-0 h-1 bg-gray-200 rounded-full" />
              <div
                className="absolute h-1 bg-black rounded-full"
                style={{
                  left: `${((rangeMin - minBound) / (maxBound - minBound)) * 100}%`,
                  right: `${100 - ((rangeMax - minBound) / (maxBound - minBound)) * 100}%`,
                }}
              />
              <input
                type="range"
                min={minBound}
                max={maxBound}
                value={rangeMin}
                onChange={(e) => handleMinChange(Number(e.target.value))}
                className="range-thumb absolute w-full appearance-none bg-transparent pointer-events-none"
                aria-label="Мінімальна ціна"
              />
              <input
                type="range"
                min={minBound}
                max={maxBound}
                value={rangeMax}
                onChange={(e) => handleMaxChange(Number(e.target.value))}
                className="range-thumb absolute w-full appearance-none bg-transparent pointer-events-none"
                aria-label="Максимальна ціна"
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400">Завантаження цін...</p>
        )}
      </div>

      {/* Color */}
      <div>
        <p className="text-xs uppercase font-bold tracking-wider mb-3">Колір</p>
        {availableColors.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {availableColors.map(color => {
              const hex = COLOR_HEX[color];
              const isSelected = selectedColors.has(color);
              return (
                <button
                  key={color}
                  onClick={() => onToggleColor(color)}
                  className="group w-11 h-11 flex items-center justify-center"
                  title={color}
                  aria-label={color}
                  aria-pressed={isSelected}
                >
                  <span
                    className={`w-8 h-8 rounded-full border transition-all duration-200 flex items-center justify-center ${
                      isSelected
                        ? 'ring-2 ring-offset-2 ring-black scale-110 shadow-sm'
                        : 'group-hover:scale-110 group-hover:shadow-sm'
                    } ${hex ? 'border-gray-200' : 'border-gray-300 bg-gray-100'}`}
                    style={hex ? { backgroundColor: hex } : undefined}
                  >
                    {!hex && <span className="text-[8px] text-gray-500">?</span>}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-gray-400">Завантаження кольорів...</p>
        )}
      </div>

      <button
        onClick={onReset}
        className="text-xs uppercase tracking-widest underline text-gray-500 hover:text-black transition-colors"
      >
        Скинути фільтри
      </button>
    </div>
  );
}
