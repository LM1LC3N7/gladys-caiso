# Réseau californien (CAISO)

Intégration non officielle. Elle lit les fichiers publics du California
Independent System Operator (CAISO), l'opérateur de la plus grande partie du
réseau électrique californien, sans compte ni clé, et publie dans Gladys :

- **le réseau** : demande et demande nette (MW), part renouvelable (%),
  intensité carbone (g/kWh), émissions de CO2 (t/h), les conditions du réseau
  publiées par l'opérateur (Normal, Flex Alert, EEA…) et un niveau d'alerte
  de 0 à 6 ;
- **les prix de gros temps réel** des trois hubs NP15 (nord de la Californie),
  SP15 (sud) et ZP26 (centre), en $/MWh, par intervalles de 5 minutes.

**Les prix de gros ne sont pas votre tarif.** Ce sont les prix du marché où
l'opérateur équilibre le réseau (prix marginal local, LMP). Votre fournisseur
(PG&E, SCE, SDG&E…) vous facture un tarif de détail qui ne les suit pas minute
par minute. Servez-vous-en comme d'un signal (bas, souvent négatif, quand le
solaire inonde le réseau), pas comme d'une facture.

Essayée contre les vrais fichiers de CAISO (Today's Outlook et OASIS) le
2026-10-30, et dans le bac à sable Gladys ; jamais testée avec un vrai Gladys
à la maison, ni pendant une vraie Flex Alert ou EEA (voir « Conditions du
réseau »).

## Mise en route

1. Installez l'intégration depuis le store, ouvrez sa page.
2. Choisissez la langue des textes, l'intervalle de lecture (5 à 60 minutes,
   5 par défaut : l'opérateur met les deux sources à jour toutes les 5
   minutes) et, pour le déclencheur de scène, le seuil de prix bas.
3. Dans l'onglet **Découverte**, créez les appareils voulus : le réseau, un ou
   plusieurs hubs. **Une source n'est lue que si un appareil en a besoin** : le
   réseau a besoin de Today's Outlook, un hub d'OASIS. Rien n'est lu avant.

## Appareils

### Réseau électrique californien (CAISO)

| Fonction                              | Unité          | Source                                         |
| ------------------------------------- | -------------- | ---------------------------------------------- |
| Demande                               | MW (dans nom)  | `CurrentSystemDemand`, avec sa propre heure    |
| Demande nette, hors éolien et solaire | MW (dans nom)  | `CurrentNetDemand`, avec sa propre heure       |
| Part renouvelable                     | %              | `renewablesPercent` (au-delà de 100 % : 100)   |
| Intensité carbone                     | g/kWh          | `currentCo2intensity` (t/MWh × 1000, exact)    |
| Émissions de CO2                      | t/h (dans nom) | `currentCo2`                                   |
| Niveau d'alerte                       | 0 à 6          | les conditions du réseau, voir plus bas        |
| Conditions du réseau                  | texte          | les mots de l'opérateur, tels que publiés      |
| État des données                      | texte          | heure du relevé, ou pourquoi rien n'est montré |

La part renouvelable est celle que publie l'opérateur : renouvelables
(solaire, éolien, géothermie, biomasse, biogaz, petite hydraulique ; la grande
hydraulique exclue, comme dans les règles californiennes) sur la demande.
Quand les renouvelables dépassent la demande (le reste exporté ou stocké),
toute l'électricité consommée est renouvelable : 100. L'intensité carbone et
les émissions sont les chiffres de CO2 de l'opérateur (importations
comprises), pas des équivalents CO2.

Les valeurs de demande ne sont pas des capteurs `energy` : un réseau entier
n'est pas un compteur de maison, et elles n'entrent pas dans les tableaux de
bord d'énergie de Gladys.

### Prix de gros CAISO NP15 / SP15 / ZP26

| Fonction                | Unité | Source                                        |
| ----------------------- | ----- | --------------------------------------------- |
| Prix de gros temps réel | $/MWh | OASIS `PRC_INTVL_LMP`, marché RTM, LMP du hub |
| État des données        | texte | l'intervalle de 5 minutes montré, ou pourquoi |

Une seule requête OASIS lit les trois hubs (l'opérateur accepte une requête
toutes les 5 secondes ; l'intégration n'en envoie jamais deux à moins d'un
intervalle). La réponse contient l'intervalle en cours et le ou les deux
suivants : quand un nouvel intervalle commence entre deux lectures, son prix
(déjà reçu) est publié aussitôt, sans requête.

## Fraîcheur : rien d'ancien montré comme neuf, jamais 0 pour une inconnue

- Une valeur est publiée **une fois par relevé de la source**, seulement tant
  qu'elle est fraîche : un relevé de Today's Outlook de **20 minutes** au plus
  (sa propre heure, passée en UTC grâce au Last-Modified du fichier), un prix
  dont l'intervalle s'est terminé il y a **10 minutes** au plus (les heures
  d'OASIS sont en UTC).
- Une valeur absente, illisible, hors bornes ou périmée **n'est pas publiée**,
  et jamais comme 0 : le texte « État des données » et l'état de
  l'intégration le disent (« Périmé, rien publié : dernier relevé du 29/10
  22:55 (heure du Pacifique) », « non publié : demande »). Les textes sont mis
  à jour quand un relevé devient périmé, même sans nouvelle lecture.
- Après un redémarrage, rien n'est publié avant un nouveau relevé (un relevé
  déjà publié avant le redémarrage n'est jamais renvoyé).
- Les heures sont celles du Pacifique (celles de l'opérateur), passées en UTC
  exactement aux changements d'heure ; dans l'heure répétée de novembre, une
  heure sans le Last-Modified de son fichier est illisible (jamais devinée).

## Conditions du réseau et niveau d'alerte

Les conditions du réseau sont la liste `gridstatus` de Today's Outlook (la
ligne « Grid conditions » de la page de l'opérateur). L'intégration reconnaît
ces mots (sans tenir compte des majuscules) et en tire un niveau :

| Niveau | Conditions                                           |
| ------ | ---------------------------------------------------- |
| 0      | Normal                                               |
| 1      | Restricted Maintenance Operations                    |
| 2      | Flex Alert                                           |
| 3      | EEA Watch (Energy Emergency Alert Watch)             |
| 4-6    | EEA 1, EEA 2, EEA 3 (Energy Emergency Alert 1, 2, 3) |

Plusieurs conditions à la fois : le niveau le plus haut. **Un mot non reconnu
rend le niveau inconnu** : le niveau n'est pas publié (jamais un niveau plus
bas), les mots de l'opérateur sont quand même publiés dans « Conditions du
réseau », et l'état dit « conditions non reconnues ». Le libellé exact d'une
EEA dans ce fichier n'a pas pu être vérifié (aucune n'a eu lieu pendant
l'écriture de l'intégration) ; l'opérateur les annonce aussi par ses propres
avis, qui restent la référence.

## Déclencheurs de scène

- **Prix de gros bas (CAISO)** : le prix d'un hub est passé sous le « Seuil
  de prix bas » de la configuration (`phase` = `started`), ou revenu au-dessus
  ou à égalité (`ended`). Filtres : le hub, la phase. Variables : hub, phase,
  prix, seuil. Seulement pour un hub dont l'appareil est créé.
- **Conditions du réseau changées (CAISO)** : le niveau d'alerte a changé
  (`level`, `previous_level`, `conditions` = les mots de l'opérateur). Filtre :
  le nouveau niveau. Seulement si l'appareil du réseau est créé.

Chacun part une fois par changement, sur un relevé frais seulement. La première
valeur vue après l'installation (ou après un nouveau seuil) sert de référence,
jamais d'événement ; le dernier état est gardé dans /data, un redémarrage ne
relance donc jamais un déclencheur. Un niveau inconnu, ou un relevé périmé,
n'est jamais un changement. Un événement que Gladys n'accepte pas est renvoyé
avec le relevé suivant si le changement tient toujours.

Pour une condition sur la valeur elle-même (« prix sous X pendant que… »), la
fonction de prix marche avec les déclencheurs habituels des appareils Gladys.

## Rythme, erreurs et état

- Chaque source à son rythme : jamais deux requêtes à moins d'un intervalle
  (gardé d'un redémarrage à l'autre), une requête à la fois, un User-Agent
  honnête, l'ETag et le Last-Modified de Today's Outlook renvoyés (un 304 garde
  le relevé et son âge). L'onglet Découverte, un appareil modifié, une
  reconnexion à Gladys n'envoient aucune requête ; enregistrer le formulaire
  n'en envoie une que si un intervalle raccourci rend une source due ; un
  appareil créé n'en envoie une que si sa source n'a pas été interrogée dans
  l'intervalle.
- HTTP 429 ou 5xx : la source se met en pause 5 minutes, doublées à chaque
  nouveau refus, de 60 secondes à 6 heures, `Retry-After` respecté ; gardée
  d'un redémarrage à l'autre ; l'autre source continue. Elle est relue dès la
  fin de la pause.
- L'état n'est « connecté » que si une source a répondu et a des données
  fraîches (juste après un redémarrage, avant la première lecture due : si une
  source a été bien lue dans l'intervalle avant le redémarrage). Il liste, en
  français et en anglais : la source injoignable, en pause, en refus, périmée,
  des valeurs non publiées, des conditions non reconnues, le « pas de données »
  ou un code d'erreur d'OASIS, /data illisible ou non inscriptible, et « les
  prix sont des prix de gros du marché, pas votre tarif ».
- `getConfig` en échec à une connexion à Gladys : nouvel essai après 5 s,
  doublé jusqu'à 5 minutes, sans fin ; l'état le dit.
- /data (le rythme, les pauses, ce qui a été publié, l'état des
  déclencheurs) : chaque attente est bornée (5 s) ; un fichier illisible est
  mis de côté, jamais écrasé, et c'est dit. **Tant que /data n'est pas
  inscriptible** (l'état le dit), tout cela n'est gardé qu'en mémoire : un
  redémarrage lit alors aussitôt, peut republier le dernier relevé et relancer
  un déclencheur ; les promesses sur les redémarrages ci-dessus ne valent que
  si /data est inscriptible.

## Sources et limites

- Today's Outlook : `https://www.caiso.com/outlook/current/stats.txt`.
- OASIS : `https://oasis.caiso.com/oasisapi/SingleZip` (interface publique,
  documentée par l'opérateur, sans clé).
- Données © California ISO. Cette intégration n'est ni affiliée à l'opérateur
  ni approuvée par lui.
- Lecture seule : l'intégration n'envoie que des requêtes GET.
