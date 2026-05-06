import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.user.upsert({
    where: { email: 'demo@qary.local' },
    update: {},
    create: { email: 'demo@qary.local', name: 'Demo User', role: 'USER' },
  });
  await prisma.user.upsert({
    where: { email: 'driver@qary.local' },
    update: {},
    create: {
      email: 'driver@qary.local',
      name: 'Demo Driver',
      role: 'DRIVER',
      driver: {
        create: { vehiclePlate: 'ABC-123', vehicleModel: 'Toyota Yaris', online: true, lastLat: -12.044, lastLng: -77.041 },
      },
    },
  });
  console.log('Seed completado.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
