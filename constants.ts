
import { Product, SizeChart, Review, RelatedColor } from './types';

export const CATEGORIES = [
  { id: 'all', label: 'Всі' },
  { id: 'Лосини', label: 'Лосини' },
  { id: 'Топ', label: 'Топи' },
  { id: 'Комплект', label: 'Комплекти' },
  { id: 'Комбінезон', label: 'Комбінезони' },
  { id: 'Рашгард', label: 'Рашгарди' },
  { id: 'Футболка', label: 'Футболки' }
];

// Reusable Data
const PLACEHOLDER_IMAGES = [
    "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1529139574466-a302d2d3f524?auto=format&fit=crop&q=80&w=800"
];

const DEFAULT_VIDEO = "dQw4w9WgXcQ"; // Placeholder video

const DEFAULT_REVIEWS: Review[] = [
    {
        user: "Анна",
        rating: 5,
        text: "Дуже задоволена якістю! Тканина приємна до тіла, розмір підійшов ідеально.",
        type: "image",
        url: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&q=80&w=200"
    },
    {
        user: "Олена",
        rating: 4,
        text: "Гарний комплект, але колір трохи відрізняється від фото.",
        type: null
    }
];

// Define Color Groups for Demo Logic
// In a real app, this would come from the backend. We link ID 85, 104, and 6 together.
const DEMO_COLOR_GROUPS: Record<number, RelatedColor[]> = {
    // Group: Naked Leggings Series
    85: [
        { name: "Бежевий", id: 85, colorCode: "#C8AD7F" },
        { name: "Чорний", id: 104, colorCode: "#000000" },
        { name: "Мокко", id: 6, colorCode: "#6F4E37" }
    ],
    104: [
        { name: "Бежевий", id: 85, colorCode: "#C8AD7F" },
        { name: "Чорний", id: 104, colorCode: "#000000" },
        { name: "Мокко", id: 6, colorCode: "#6F4E37" }
    ],
    6: [
        { name: "Бежевий", id: 85, colorCode: "#C8AD7F" },
        { name: "Чорний", id: 104, colorCode: "#000000" },
        { name: "Мокко", id: 6, colorCode: "#6F4E37" }
    ]
};

// Global Size Charts
export const SIZE_CHARTS: Record<string, SizeChart> = {
    'leggings': {
        columns: ["Розмір", "Обхват талії (см)", "Обхват стегон (см)"],
        rows: [
            ["S", "60-68", "88-95"],
            ["M", "69-75", "96-102"],
            ["L", "76-84", "103-110"]
        ]
    },
    'top': {
        columns: ["Розмір", "Обхват грудей (см)", "Під грудьми (см)"],
        rows: [
            ["S", "82-88", "68-73"],
            ["M", "89-95", "74-79"],
            ["L", "96-102", "80-86"]
        ]
    },
    'set': {
        columns: ["Розмір", "Груди (см)", "Талія (см)", "Стегна (см)"],
        rows: [
            ["S", "82-88", "60-68", "88-95"],
            ["M", "89-95", "69-75", "96-102"],
            ["L", "96-102", "76-84", "103-110"]
        ]
    },
    'bodysuit': {
        columns: ["Розмір", "Зріст", "Груди", "Стегна"],
        rows: [
            ["S", "160-168", "82-88", "88-94"],
            ["M", "165-172", "88-94", "94-100"],
            ["L", "170-178", "94-100", "100-106"]
        ]
    },
    'rashguard': {
         columns: ["Розмір", "Груди (см)", "Рукав (см)"],
         rows: [
             ["S", "82-88", "60"],
             ["M", "88-94", "61"],
             ["L", "94-100", "62"]
         ]
    },
    'default': {
        columns: ["Розмір", "Параметри"],
        rows: [
            ["S", "Стандарт S"],
            ["M", "Стандарт M"],
            ["L", "Стандарт L"]
        ]
    }
};

// Helper to fill product data
const enrichProduct = (p: Partial<Product> & { id: number; title: string; price: number; images: string[] }): Product => {
    // Determine category from title
    let sizeCategory = 'default';
    const t = p.title.toLowerCase();
    if (t.includes('лосини')) sizeCategory = 'leggings';
    else if (t.includes('топ')) sizeCategory = 'top';
    else if (t.includes('комплект')) sizeCategory = 'set';
    else if (t.includes('комбінезон') || t.includes('комбенізон')) sizeCategory = 'bodysuit';
    else if (t.includes('рашгард')) sizeCategory = 'rashguard';
    else if (t.includes('футболка')) sizeCategory = 'top';

    return {
        ...p,
        // Ensure at least 3 images for testing gallery
        images: [...p.images, ...PLACEHOLDER_IMAGES],
        sizes: p.sizes || ["S", "M", "L"],
        colors: p.colors || ["Standard"],
        videoId: p.videoId || DEFAULT_VIDEO,
        reviews: p.reviews || DEFAULT_REVIEWS,
        sizeCategory: sizeCategory,
        // Inject related colors if they exist in our demo mapping
        relatedColors: DEMO_COLOR_GROUPS[p.id] || []
    };
};

export const PRODUCTS: Product[] = [
    {
        id: 1,
        title: "RA рашгард на блискавці",
        price: 899,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-03-06/uEz3DWtfCnxEWERGDaSB7U6peslG01br.JPG"],
        sizes: ["S", "M", "L"],
        colors: [],
    },
    {
        id: 2,
        title: "MA комплект (рашгард + лосини) Verona",
        price: 1499,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-04-11/VGU1A2hGgZzkaNgtD5DJ9flcFmrXnnsX.PNG"],
        sizes: ["S", "M", "L"],
        colors: [],
    },
    {
        id: 3,
        title: "MA лосини Verona з 3d push-up",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-08-28/Usgrk89giBertxuPCuZYmKQ75hhL1S6E.JPG"],
        sizes: ["S", "M", "L", "XL"],
        colors: ["Розмір"]
    },
    {
        id: 4,
        title: "KB комбінезон без рукавів (модель 2 )",
        price: 1599,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-03-06/2L8hLaq63ksIprjxL0AOqRTCGSYWJjzd.jpg"],
        sizes: ["S", "M", "L", "XL"],
        colors: ["Розмір"]
    },
    {
        id: 6,
        title: "BE лосини безшовні без ефекту пуш-ап",
        price: 645,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-01/HibsuNQJwECh24OziAZg0AAEAScmWK4y.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 8,
        title: "R рашгард",
        price: 899,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-03-06/uEz3DWtfCnxEWERGDaSB7U6peslG01br.JPG"],
        sizes: ["M", "S", "L"],
        colors: ["розмір"]
    },
    {
        id: 9,
        title: "KK Лосини з push-up",
        price: 749,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-08-29/IWJRZ1H1AxX4mIBwNYNVqptcBtzOEJAW.jpeg"],
        sizes: ["S", "L"],
        colors: ["розмір"]
    },
    {
        id: 10,
        title: "KK Топ",
        price: 599,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-08-29/fmN0Yq7uLPGYPomrU0hqhPLG9pRexCV1.jpeg"],
        sizes: ["S", "L"],
        colors: ["розмір"]
    },
    {
        id: 13,
        title: "KL Лосини класичні з push-up",
        price: 749,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-05-09/joUNLaaJtwXxFz0BUU3hDMBXxDShiDOK.JPG"],
        sizes: ["S", "M", "L", "XL"],
        colors: ["розмір"]
    },
    {
        id: 14,
        title: "KR Комбінезон із довгим рукавом",
        price: 1799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-03-27/85fSTSeQQozgZF95QR06mkwqwUqmKyhq.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 15,
        title: "QA Топ перехресний перед",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-03-27/o5xflMlYIv21XwjWVs0vrVJWFudRiFLl.jpeg"],
        sizes: ["S", "M", "L", "XL", "XXL"],
        colors: ["Розмір"]
    },
    {
        id: 16,
        title: "QC Топ із перехресною спинкою",
        price: 749,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-03-27/sGXAV78PCCQcyYhTaqJoCtdpklW1JKt9.jpeg"],
        sizes: ["S", "M", "L", "XL", "XXL"],
        colors: ["Розмір"]
    },
    {
        id: 17,
        title: "SQ Лосини з push-up з V-подібним поясом",
        price: 899,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-04-01/sBMKXvzkVrrrcLv0wcj1PisJK4IdplNj.JPEG"],
        sizes: ["S", "M", "L", "XL"],
        colors: ["Розмір"]
    },
    {
        id: 18,
        title: "KV Комбенізон без пушап, зі швами та зйомними чашками",
        price: 1799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-04-09/OAFAw5qbgrrFUmUspmvfHjPzBxcYkb6J.jpg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 20,
        title: "RB футболка на блискавці",
        price: 699,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-08-28/1IvPfRldHkwekEhh3HPwwGYpRxiOlNO0.JPG"],
        sizes: ["S", "L"],
        colors: ["Розмір"]
    },
    {
        id: 21,
        title: "RU Лосини у рубчик з push-up",
        price: 750,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-08-29/YKl0uS357M3FULESjVPoR1BdFYS9f0xY.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 22,
        title: "MA рашгард Verona",
        price: 699,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-04-11/qWHr5rcc60bqIWEoDB0yWVS2iOtZDD19.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 23,
        title: "MS комплект (футболка + вело) Verona",
        price: 1299,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-04-11/VGU1A2hGgZzkaNgtD5DJ9flcFmrXnnsX.PNG"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 66,
        title: "MS велоcипедки Verona",
        price: 699,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/remote?url=https%3A%2F%2Ftviykomplekt.api.keycrm.app%2Ffile-storage%2Fthumbnails%2Ftviykomplekt%2Fuploads%2F2025-04-11%2FQxlQHPJBzFxscRlgM7iaYQZUGCHqghZg.jpg"],
        sizes: ["S", "M", "L"],
        colors: ["Колір"]
    },
    {
        id: 71,
        title: "KN Шовний напівкомбенізон без пушап",
        price: 1499,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-04-11/hgtEbgirz7eXXoU4QLMiTMU7cQv4V6mR.jpg"],
        sizes: ["S", "M", "L"],
        colors: ["Колір", "Розмір"]
    },
    {
        id: 75,
        title: "MS футболка Verona",
        price: 699,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-04-11/kh3vbfizXO5KWTzeSX0TfczWzJSIuUFn.jpg"],
        sizes: ["S", "M", "L"],
        colors: ["Колір"]
    },
    {
        id: 76,
        title: "RU Футболка у рубчик",
        price: 599,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-08-29/XDDf3EBPeE9ua6bPbtLLgfZkKgEMnGIo.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 77,
        title: "FD Футболка подовжена приталена",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-08-29/j0NdsFwmlELg4kQtuSLJ3KJUrch6n6uc.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 78,
        title: "WV Комплект WAVE (вело + топ)",
        price: 1599,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-05-09/g8a3qx7Nlq8lBHF68z48TJoxYuM1Bgou.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 80,
        title: "KS напівкомбінезон із закритою спинкою",
        price: 1499,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-05-09/8pO62aUF30HsY8Hvu4LmBBJVbXSHxIu7.JPG"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 83,
        title: "SQ Велосипедки з V-подібним поясом",
        price: 699,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-05-09/wQ4GCu96oa3dWq0bMRJIpkrThw7PVVzv.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Колір"]
    },
    {
        id: 84,
        title: "KP напівкомбінезон майкою",
        price: 1499,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-07-04/i8OtbjUydE6jBjb809LbkZULdf1V7y8j.PNG"],
        sizes: ["S", "L", "M"],
        colors: ["Розмір"]
    },
    {
        id: 85,
        title: "LB Лосини без push-up \"Naked\"",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-08-28/idZ1rBcz11Wli0oNMG07Ox85MFFF7b6o.JPG"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 86,
        title: "WV лосини без push-up \"WAVE\"",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-08-28/JoRx3cYW2SQOVaIGbwYDoPtFbSzUhemK.JPG"],
        sizes: ["M", "L", "S"],
        colors: ["Розмір"]
    },
    {
        id: 94,
        title: "LI Лосини V-push-up",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-01/8gUL58c0AhNLObGJdAyB9n7nNoTtvdjV.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 96,
        title: "WV Топ \"WAVE\"",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-01/yajW2IUqXh8KGJ0FSp2NGUUWcKehDTgn.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 99,
        title: "LB Майка »Naked\"",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-01/x65hUUEayvVhOJR73PbWCjgtjWc3PKXf.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 100,
        title: "LB Велосипедки »Naked\"",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-01/YI2ZJtoLZgGUrh558M8oOhtHYKU0svpS.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 101,
        title: "LB Футболка вкорочена зі зйомними чашками",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-01/e08vCDdpvI8KVwzRyxbU7tHotSKrLV8d.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 102,
        title: "LB Футболка подовжена приталена \"Naked\"",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-01/dmZqnAIl5CxQaGfZxL7BFSqZcacrjajp.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 103,
        title: "LB Кроп-топ із довгим рукавом \"Naked\"",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-01/j5mhhxZ6HYaOt5GdCDn5eNC4jnzbDYIT.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 104,
        title: "LВ Лосини з push-up ефектом \"Naked\"",
        price: 999,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-11-01/DixTUrV5VY8iMsWk406D8dQxYdgMtfNG.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 105,
        title: "RI Лосини у рубчик без push-up",
        price: 740,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-03/mT4VHOsBbW3A6IgzAEV9Ck7LMZLZ74oz.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 106,
        title: "TW Футболка оверсайз",
        price: 699,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-04/bmYT6tLbzUp6NsbAsaDWSoKaB2Romuf9.jpeg"],
        sizes: ["S", "M", "L", "XL"],
        colors: ["Розмір"]
    },
    {
        id: 107,
        title: "TZ Топ із застібкою",
        price: 799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-10/q8o1YgvP3i8WxHrndtFe0514nElmE7MV.jpeg"],
        sizes: ["S", "M", "L", "XL", "XXL"],
        colors: ["Розмір"]
    },
    {
        id: 108,
        title: "KS комбінезон із закритою спинкою короткий рукав",
        price: 1699,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-11/bf5E03IvhT80RVgUNt2SgyAIAau3GZK2.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 109,
        title: "KS комбінезон із закритою спинкою довгий рукав",
        price: 1599,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-11/k50zBhc4mVGRGjsyobXmUBDThRdP1saP.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 111,
        title: "KF Комбінезон утеплений на флісі",
        price: 1699,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-11-01/77SYo5xzrQmO3WrcCHf2DJtEkANOtbxt.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 112,
        title: "KX Комбінезон зі швами та закритою спинкою",
        price: 1799,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-09-30/nFqqZmyoQuzBPeH2qaC8ftbnaKB0ft1Q.jpeg"],
        sizes: ["S", "L", "M"],
        colors: ["Розмір"]
    },
    {
        id: 114,
        title: "LS лосини утеплені на хутрі",
        price: 699,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-11-01/qUBQZjfViboD17T52gknDT04KVquQUCv.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір", "Чорний"]
    },
    {
        id: 115,
        title: "LF Лосини утеплені мікрофліс",
        price: 899,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-11-08/kTecEN5vWCI970K9qwTZQSgcsImbc7c3.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    },
    {
        id: 116,
        title: "TB термобілизна",
        price: 1299,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-11-01/gvPBErhj4BKO7LCYoM5eWHoPjWdL38wc.jpeg"],
        sizes: ["S", "M", "L", "XL"],
        colors: ["Розмір"]
    },
    {
        id: 117,
        title: "HI Лосини на хутрі Італія",
        price: 749,
        images: ["https://tviykomplekt.api.keycrm.app/file-storage/thumbnails/tviykomplekt/uploads/2025-11-13/f76S8vLAyl1XmNZtDZwdcWZw4I4Bdq2g.jpeg"],
        sizes: ["S", "M", "L"],
        colors: ["Розмір"]
    }
].map(enrichProduct);
