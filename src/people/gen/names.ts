import type { Rng } from '@core/rng';

/** First and family names for a new person (common in Brazil and abroad). */
const FEMALE = ['Ana', 'Maria', 'Júlia', 'Beatriz', 'Camila', 'Larissa', 'Fernanda', 'Helena', 'Alice', 'Luiza', 'Sofia', 'Marina',
  'Yasmin', 'Aiko', 'Amara', 'Priya', 'Leila', 'Elena', 'Clara', 'Rosa', 'Iara', 'Luana', 'Mei', 'Zara'];
const MALE = ['João', 'Pedro', 'Lucas', 'Gabriel', 'Rafael', 'Mateus', 'Gustavo', 'Thiago', 'Bruno', 'Carlos', 'Davi', 'Miguel',
  'Arthur', 'Kenji', 'Kofi', 'Ravi', 'Omar', 'Diego', 'Luís', 'Caio', 'Henrique', 'Wei', 'Tomás', 'Samuel'];
const FAMILY = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Pereira', 'Costa', 'Ferreira', 'Almeida', 'Ribeiro', 'Carvalho',
  'Gomes', 'Martins', 'Rocha', 'Barbosa', 'Moreira', 'Nascimento', 'Araújo', 'Tanaka', 'Mensah', 'Sharma', 'Haddad', 'Chen', 'García'];

export function randomName(rng: Rng, sex: number): string {
  return `${rng.pick(sex >= 0.5 ? MALE : FEMALE)} ${rng.pick(FAMILY)}`;
}
