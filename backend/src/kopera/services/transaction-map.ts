import type { PrismaClient } from '@prisma/client';

export class TransactionMapService {
  constructor(private prisma: PrismaClient) {}

  async recordLocation(userId: string, transactionId: string, data: {
    latitude: number;
    longitude: number;
    city?: string;
    country?: string;
    deviceId?: string;
  }) {
    const txn = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!txn) throw new Error('transaction_not_found');
    if ((txn as any).userId !== userId) throw new Error('transaction_not_found');

    return this.prisma.transactionLocation.create({
      data: {
        transactionId,
        userId,
        latitude: data.latitude,
        longitude: data.longitude,
        city: data.city || null,
        country: data.country || null,
        deviceId: data.deviceId || null,
        recordedAt: new Date(),
      },
    });
  }

  async getTransactionLocations(userId: string) {
    return this.prisma.transactionLocation.findMany({ where: { userId } });
  }

  async getLocationByTransaction(userId: string, transactionId: string) {
    const loc = await this.prisma.transactionLocation.findFirst({
      where: { userId, transactionId },
    });
    if (!loc) throw new Error('location_not_found');
    return loc;
  }

  async getGeoAnalytics(userId: string) {
    const locations = await this.prisma.transactionLocation.findMany({ where: { userId } });

    if (locations.length === 0) {
      return {
        totalLocations: 0,
        countries: [],
        cities: [],
        heatmapClusters: [],
        geoLevel: 'no_data',
      };
    }

    const countryMap: Record<string, number> = {};
    const cityMap: Record<string, number> = {};

    for (const loc of locations as any[]) {
      if (loc.country) {
        countryMap[loc.country] = (countryMap[loc.country] || 0) + 1;
      }
      if (loc.city) {
        cityMap[loc.city] = (cityMap[loc.city] || 0) + 1;
      }
    }

    const countries = Object.entries(countryMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const cities = Object.entries(cityMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const clusters = this.clusterLocations(locations as any[]);

    const spread = countries.length;
    let geoLevel: string;
    if (spread >= 5) geoLevel = 'global';
    else if (spread >= 3) geoLevel = 'regional';
    else if (spread >= 2) geoLevel = 'multi_country';
    else geoLevel = 'local';

    return {
      totalLocations: locations.length,
      countries,
      cities,
      heatmapClusters: clusters,
      geoLevel,
    };
  }

  private clusterLocations(locations: Array<{ latitude: number; longitude: number }>) {
    if (locations.length === 0) return [];

    const clusters: Array<{ lat: number; lng: number; count: number }> = [];
    const threshold = 0.5;

    for (const loc of locations) {
      const existing = clusters.find(
        (c) => Math.abs(c.lat - loc.latitude) < threshold && Math.abs(c.lng - loc.longitude) < threshold,
      );
      if (existing) {
        existing.count++;
        existing.lat = (existing.lat * (existing.count - 1) + loc.latitude) / existing.count;
        existing.lng = (existing.lng * (existing.count - 1) + loc.longitude) / existing.count;
      } else {
        clusters.push({ lat: loc.latitude, lng: loc.longitude, count: 1 });
      }
    }

    return clusters.sort((a, b) => b.count - a.count);
  }
}
