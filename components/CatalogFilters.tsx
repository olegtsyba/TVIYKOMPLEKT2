import React, { useState } from 'react';
import { COLOR_HEX } from '../constants';

export type SortOption = 'default' | 'price-asc' | 'price-desc';

export interface FilterCategory {
  id: string;
  label: string;
}

interface CatalogFiltersProps {
  categories: FilterCategory[];
  activeCategory: string;
  onSelectCategory: (id: string) => void;
  availableColors: string[];
  selectedColors: Set<string>;
  onToggleColor: (color: string) => void;
  availableSizes: string[];
  selectedSizes: Set<string>;
  onToggleSize: (size: string) => void;
  priceBounds: [number, number];
  priceRange: [number, number];
  onChangePriceRange: (range: [number, number]) => void;
  sortOption: SortOption;
  onChangeSort: (option: SortOption) => void;
  onReset: () => void;
}

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
  >
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>
);

// Collapsed-by-default accordion section, used for Category/Color/Price.
function FilterSection({
  title, badge, children,
}: { title: string; badge?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-200 pb-4">
      <button
        onClick={() => setOpen(prev => !prev)}
        className="w-full flex justify-between items-center text-left"
        aria-expanded={open}
      >
        <span className="text-xs uppercase font-bold tracking-wider flex items-center gap-2">
          {title}
          {!!badge && <span className="w-5 h-5 rounded-full bg-black text-white text-[10px] flex items-center justify-center">{badge}</span>}
        </span>
        <ChevronIcon open={open} />
      </button>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

// Shared filter controls (category + color + price range + sort) rendered
// both in the desktop sidebar and the mobile bottom sheet - kept as one
// component so the two surfaces can't drift apart.
export default function CatalogFilters({
  categories,
  activeCategory,
  onSelectCategory,
  availableColors,
  selectedColors,
  onToggleColor,
  availableSizes,
  selectedSizes,
  onToggleSize,
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

  const isPriceActive = hasBounds && (rangeMin !== minBound || rangeMax !== maxBound);

  return (
    <div className="space-y-6">
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

      {/* Category */}
      <FilterSection title="Категорія" badge={activeCategory !== 'all' ? 1 : 0}>
        <div className="space-y-1">
          {categories.map(cat => {
            const isSelected = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => onSelectCategory(cat.id)}
                className={`w-full flex items-center gap-3 text-left px-2 py-2 text-sm transition-colors ${
                  isSelected ? 'font-semibold text-black' : 'text-gray-600 hover:text-black'
                }`}
              >
                <span className={`w-3.5 h-3.5 rounded-full border flex-shrink-0 ${isSelected ? 'border-black bg-black' : 'border-gray-300'}`} />
                {cat.label}
              </button>
            );
          })}
        </div>
      </FilterSection>

      {/* Color */}
      <FilterSection title="Колір" badge={selectedColors.size}>
        {availableColors.length > 0 ? (
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {availableColors.map(color => {
              const hex = COLOR_HEX[color];
              const isSelected = selectedColors.has(color);
              return (
                <button
                  key={color}
                  onClick={() => onToggleColor(color)}
                  className={`w-full flex items-center gap-3 text-left px-2 py-2 text-sm transition-colors ${
                    isSelected ? 'bg-gray-100 font-semibold text-black' : 'text-gray-600 hover:bg-gray-50 hover:text-black'
                  }`}
                  aria-pressed={isSelected}
                >
                  <span
                    className={`w-5 h-5 rounded-full border flex-shrink-0 ${hex ? 'border-gray-300' : 'border-gray-300 bg-gray-100'} ${isSelected ? 'ring-2 ring-offset-1 ring-black' : ''}`}
                    style={hex ? { backgroundColor: hex } : undefined}
                  />
                  <span className="capitalize">{color}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-gray-400">Завантаження кольорів...</p>
        )}
      </FilterSection>

      {/* Size */}
      <FilterSection title="Розмір" badge={selectedSizes.size}>
        {availableSizes.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {availableSizes.map(size => {
              const isSelected = selectedSizes.has(size);
              return (
                <button
                  key={size}
                  onClick={() => onToggleSize(size)}
                  aria-pressed={isSelected}
                  className={`min-w-[2.5rem] h-10 px-2 flex items-center justify-center border text-sm transition-all duration-200 ${
                    isSelected
                      ? 'border-black bg-black text-white'
                      : 'border-gray-200 hover:border-black text-gray-700'
                  }`}
                >
                  {size}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-gray-400">Завантаження розмірів...</p>
        )}
      </FilterSection>

      {/* Price */}
      <FilterSection title="Ціна" badge={isPriceActive ? 1 : 0}>
        {hasBounds ? (
          <>
            <div className="flex items-center justify-between text-sm font-medium text-gray-900 mb-4">
              <span>{rangeMin} UAH</span>
              <span>{rangeMax} UAH</span>
            </div>
            <div className="relative h-6 flex items-center">
              <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 bg-gray-200 rounded-full" />
              <div
                className="absolute top-1/2 -translate-y-1/2 h-1.5 bg-black rounded-full"
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
                className="range-thumb absolute left-0 right-0 top-1/2 -translate-y-1/2 w-full appearance-none bg-transparent pointer-events-none"
                aria-label="Мінімальна ціна"
              />
              <input
                type="range"
                min={minBound}
                max={maxBound}
                value={rangeMax}
                onChange={(e) => handleMaxChange(Number(e.target.value))}
                className="range-thumb absolute left-0 right-0 top-1/2 -translate-y-1/2 w-full appearance-none bg-transparent pointer-events-none"
                aria-label="Максимальна ціна"
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400">Завантаження цін...</p>
        )}
      </FilterSection>

      <button
        onClick={onReset}
        className="text-xs uppercase tracking-widest underline text-gray-500 hover:text-black transition-colors"
      >
        Скинути фільтри
      </button>
    </div>
  );
}
