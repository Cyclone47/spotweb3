# Spotweb3 installeren op Proxmox

Je hebt een Proxmox-node met internet nodig, een netwerk met DHCP en ongeveer
2 GB vrij RAM. De installer maakt een **nieuwe Debian 13-container** met
2 CPU-cores en een schijf van 16 GB. Apache, PHP, de downloader-relay en het
automatisch ophalen van spots worden meteen geïnstalleerd.

## 1. Open de Shell van je Proxmox-node

Log in op de Proxmox-webinterface, klik links op je **node** (bijvoorbeeld `pve`)
en kies **Shell**. Voer de opdracht uit als `root`, op de host.

## 2. Plak deze opdracht

```bash
curl -fsSL https://raw.githubusercontent.com/Cyclone47/spotweb3/main/proxmox/quick-install.sh -o /tmp/spotweb3-install.sh && bash /tmp/spotweb3-install.sh
```

De installer kiest automatisch een vrij container-ID en downloadt het actuele
Debian 13-template en de Spotweb3-broncode. Je hoeft niets vooraf te downloaden
of vanaf je eigen computer te kopiëren.

- Zijn er meerdere opslaglocaties? Kies de gewenste naam, of druk op **Enter**
  voor de voorgestelde keuze. Containeropslag en templateopslag kunnen verschillen;
  `local-lvm` en `local` is bijvoorbeeld normaal.
- Controleer het overzicht en druk op **Enter** om te installeren.
- Wacht tot **Ready** verschijnt. De installatie kan enkele minuten duren.

Standaard gebruikt hij netwerkbridge `vmbr0` en DHCP. Heeft jouw netwerk een
andere bridge, gebruik dan de aangepaste opdracht onderaan.

## 3. Open de getoonde link

Aan het einde verschijnt bijvoorbeeld `http://192.168.1.120/?page=setup`.
Open **de link die jouw installer toont** op een computer in hetzelfde netwerk.
Stel in de wizard je Spotweb-beheeraccount en Usenet-servergegevens in.

In **Admin Center → Overview → Automatic spot retrieval** kies je hoe vaak
nieuwe spots worden opgehaald, bijvoorbeeld iedere 5, 15 of 30 minuten.
De container en achtergrondservices starten automatisch mee met Proxmox.

**Voor Download in browser vanaf een andere computer is HTTPS nodig**, met een
certificaat dat je browser vertrouwt. Gebruik hiervoor je HTTPS-reverseproxy en
stuur door naar poort 80 van de container, inclusief WebSockets op
`/nntp-relay-ws`. De eerste installatie en normaal bladeren werken ook via HTTP.

## Wachtwoorden en beheer

Er is geen CentOS nodig; deze installer gebruikt Debian. Er wordt geen gedeeld
Linux- of Spotweb-wachtwoord ingesteld. Het **Spotweb-wachtwoord kies je zelf in
de wizard**. Voor beheer van Linux voer je op de Proxmox-host dit uit:

```bash
pct enter 120
```

Vervang `120` door het getoonde container-ID. Hiervoor is geen Linux-rootwachtwoord
nodig. Wil je er toch een instellen, voer dan binnen die container `passwd` uit.
Een SSH-sleutel kun je bij installatie meegeven met `--ssh-key`.

## Volledig unattended of eigen instellingen

Zonder vragen, met de getoonde standaardkeuzes:

```bash
curl -fsSL https://raw.githubusercontent.com/Cyclone47/spotweb3/main/proxmox/quick-install.sh -o /tmp/spotweb3-install.sh && bash /tmp/spotweb3-install.sh --yes
```

Eigen opslag, bridge of capaciteit (pas de namen aan jouw Proxmox aan):

```bash
bash /tmp/spotweb3-install.sh --yes --storage local-zfs --template-storage local --bridge vmbr1 --memory 4096 --disk 32
```

Optioneel: `--id 120`, `--hostname spotweb`, `--cores 2`,
`--ssh-key /root/.ssh/id_ed25519.pub`. Met `--dry-run` controleer je de keuzes
zonder iets te downloaden of aan te maken. De installer maakt altijd een nieuwe
container; opnieuw uitvoeren werkt geen bestaande installatie bij.

## Als de installatie stopt

De foutmelding blijft in de Shell staan. Een aangemaakte container blijft bestaan
zodat je hem kunt inspecteren met `pct enter ID`. Bij netwerkproblemen controleer
je of de gekozen bridge DHCP, DNS en internettoegang biedt. Maak na een geslaagde
installatie een Proxmox-back-up; de database staat in `/var/lib/spotweb` binnen
de container.

Zie de [uitgebreide handleiding](docker-and-proxmox.md#services-and-data) voor
services, logboeken, back-ups en updates. De Debian-installatie is getest op
Debian 12 en 13; een volledige installatie op een echte Proxmox-host moet nog
in de praktijk worden bevestigd.
