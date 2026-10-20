export const DAYS = [
  { key: "monday", short: "Mon", label: "Monday" },
  { key: "tuesday", short: "Tue", label: "Tuesday" },
  { key: "wednesday", short: "Wed", label: "Wednesday" },
  { key: "thursday", short: "Thu", label: "Thursday" },
  { key: "friday", short: "Fri", label: "Friday" },
];

export function todayKey(date = new Date()) {
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][date.getDay()];
}

export function weekDates(reference = new Date()) {
  const monday = new Date(reference);
  const offset = (reference.getDay() + 6) % 7;
  monday.setDate(reference.getDate() - offset);
  return Object.fromEntries(DAYS.map((day, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return [day.key, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`];
  }));
}
