// 共用报销规则：市内交通补助按天判定
// 注意：这里的「80 元/人/天」是**市内交通补助**，不是住宿的「包干」——
// 包干只用于住宿费（住宿费是否包干由系统按城市/天数/金额判定）。
// 市内交通规则（用户口径 + 学校页面说明）：
//   每天网约车/市内交通 ≤80 元 → 该天领 80 元/人/天补助，不交票；
//   超过 80 元 → 该天交发票按实际金额实报，不再领当天的补助。
export const CITY_RATE = 80;

function normDate(v) {
  const m = String(v || "").match(/(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export function cityTransportPlan(ds, people = 1) {
  const persons = Math.max(1, Number(people) || 1);
  const cars = ((ds && ds.invoices) || []).filter((i) => i.kind === "网约车");
  const trips = ((ds && ds.itineraries) || []).flatMap((it) => it.trips || []);
  const tripDates = [...new Set(trips.map((t) => t.date).filter(Boolean))].sort();
  const carTotal = cars.reduce((s, i) => s + Number(i.total || 0), 0);

  if (!tripDates.length) {
    return { ok: false, why: "没有行程日期", persons, rate: CITY_RATE, carTotal, days: [], subsidyDays: 0, subsidyAmount: 0, actualAmount: 0, attach: [] };
  }

  // 发票号 → 行程日期；没有行程单的票退回开票/乘车日期
  const byNo = new Map();
  for (const t of trips) if (t.invoice_no) byNo.set(t.invoice_no, t.date);
  const dayOf = (inv) => (inv.number && byNo.get(inv.number)) || normDate(inv.travel_date || inv.date);

  const start = tripDates[0];
  const end = tripDates[tripDates.length - 1];
  const allDays = [];
  for (let t = Date.parse(start + "T00:00:00Z"); t <= Date.parse(end + "T00:00:00Z"); t += 86400000) {
    allDays.push(new Date(t).toISOString().slice(0, 10));
  }

  const days = allDays.map((date) => {
    const invs = cars.filter((i) => dayOf(i) === date);
    const amount = invs.reduce((s, i) => s + Number(i.total || 0), 0);
    return {
      date,
      amount,
      count: invs.length,
      numbers: invs.map((i) => i.number),
      mode: amount <= CITY_RATE ? "subsidy" : "actual",
    };
  });

  const subsidyDays = days.filter((d) => d.mode === "subsidy").length;
  const actualDays = days.filter((d) => d.mode === "actual");
  // 兜底：没有行程日期可归的网约车票（比如缺行程单），不能悄悄丢掉，一律算实报并交票
  const assigned = new Set(days.flatMap((d) => d.numbers));
  const unassigned = cars.filter((i) => !assigned.has(i.number));
  const unassignedAmount = unassigned.reduce((s, i) => s + Number(i.total || 0), 0);
  return {
    ok: true,
    persons,
    rate: CITY_RATE,
    days,
    subsidyDays,
    subsidyAmount: CITY_RATE * subsidyDays * persons,
    actualAmount: actualDays.reduce((s, d) => s + d.amount, 0) + unassignedAmount,
    actualCount: actualDays.reduce((s, d) => s + d.count, 0) + unassigned.length,
    attach: [...actualDays.flatMap((d) => d.numbers), ...unassigned.map((i) => i.number)],
    unassigned: unassigned.map((i) => i.number),
    unassignedAmount,
    carTotal,
    dayCount: days.length,
  };
}
