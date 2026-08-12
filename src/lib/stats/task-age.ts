export interface TaskAgeBucket {
  label: string;
  count: number;
  minDays: number;
  maxDays: number | null;
}

export function buildTaskAgeDistribution(ages: readonly number[]): TaskAgeBucket[] {
  const buckets: TaskAgeBucket[] = [
    { label: '< 1 day', count: 0, minDays: 0, maxDays: 1 },
    { label: '1–7 days', count: 0, minDays: 1, maxDays: 7 },
    { label: '8–30 days', count: 0, minDays: 8, maxDays: 30 },
    { label: '31–60 days', count: 0, minDays: 31, maxDays: 60 },
    { label: '61–90 days', count: 0, minDays: 61, maxDays: 90 },
    { label: '> 90 days', count: 0, minDays: 91, maxDays: null },
  ];

  for (const age of ages) {
    if (age < 1) buckets[0].count++;
    else if (age <= 7) buckets[1].count++;
    else if (age <= 30) buckets[2].count++;
    else if (age <= 60) buckets[3].count++;
    else if (age <= 90) buckets[4].count++;
    else buckets[5].count++;
  }

  return buckets;
}
