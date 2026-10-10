// Weather watch for Ho Chi Minh City: morning update, rain alert and evening caution to a group.
// The decision logic is pure (tested with node). Forecast data: Open-Meteo, no key needed.

const VN_OFFSET = 7 * 60 * 60 * 1000;
export const HCMC = { lat: 10.78, lon: 106.7, name: "TP. Hồ Chí Minh" };
const RAIN_NOW_MM = 0.2; // any measurable rain
const EVENING_PROB = 50; // % chance that is worth warning about

// Vietnam clock: minutes since midnight and a day key like "2026-10-10"
export function vnClock(ms) {
  const d = new Date(ms + VN_OFFSET);
  return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
}

// hourly: [{hour (0-23), prob (%), precip (mm)}] for today
export function rainAdvice({ nowPrecip, hourly }) {
  const rainNow = Number(nowPrecip || 0) >= RAIN_NOW_MM;
  const evening = (hourly || []).filter((h) => h.hour >= 17 && h.hour <= 20);
  const eveningRain = evening.some((h) => h.prob >= EVENING_PROB || h.precip >= 0.5);
  return { rainNow, eveningRain };
}

// Messages to send at 16:00 (empty array = nothing to say)
export function afternoonMessages({ rainNow, eveningRain }) {
  const out = [];
  if (rainNow) out.push("🌧 Đang mưa ở TP.HCM. Cả nhà nhớ mang áo mưa, đi đường chậm và cẩn thận.");
  if (eveningRain) out.push("🌙 Tối nay có khả năng mưa. Khi về nhà trời tối, cả nhà đi xe cẩn thận, chú ý đường trơn và ngập.");
  return out;
}

export function morningMessage({ tempMin, tempMax, rainChance, rainNow }) {
  const rainText = rainNow
    ? "Hiện đang mưa, nhớ mang áo mưa."
    : rainChance >= EVENING_PROB
      ? `Khả năng mưa hôm nay khoảng ${rainChance}%, nhớ mang áo mưa.`
      : "Hôm nay ít khả năng mưa.";
  return `☀️ Thời tiết TP.HCM hôm nay: ${tempMin}–${tempMax}°C. ${rainText}`;
}
