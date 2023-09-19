import os from 'os';
import fs from 'fs';
import inquirer from 'inquirer';
import path from 'path';
import fetch from 'node-fetch';
import { createRequire } from "module";
import { calculate } from "./lib/jpg.mjs";

main().catch(err => console.log(err.message, err.stack)).finally(() => {
    console.log('end');
});


async function main() {
    //1 : R�cup�re la liste des prospectus
    const prospectusList = await getProspectusList();

    //2 : Choix du prospectus par l'utilisateur
    const prospectus = await selectProspectus(prospectusList);

    //3 : Choix du magasin par l'utilisateur
    const choosenStore = await selectStore();
    const storeId = choosenStore.properties.user_properties.signCode;

    //4 : R�cup�ration de la liste des pages du prospectus pour le magasin
    const prospectusPages = await getProspectusPagesList(prospectus.id, storeId);

    //5 : T�l�chargement des pages
    const pages = await saveProspectus(prospectus, prospectusPages);

    //6 : R�cup�re les dimensions des images pour faire le pdf ( On consi�dre que ce sont tous des JPG aux memes dimensions)
    const pdfsize = await getImageDimensions(pages[0]);

    //calcule le nom du pdf
    const prospectustitle = sanatizePath(prospectus.title);
    const pdfname = prospectustitle+'.pdf';
    const pdfpath = path.resolve('.', pdfname );

    //7: cr�e le PDF
    await saveChapterPagesPDF(pdfpath, pages, pdfsize);

    //8 : TODO Supression des images?
    const pathToClean = path.dirname(pages[0]);
    fs.rmSync(pathToClean, { recursive: true, force: true });


}

/**
 * R�cup�re la liste des prospectus actuels (uniquement pour les Hypermarch�s)
 * @returns un tableau de prospectus {id, title, start, end}
 */
async function getProspectusList() {
    const result = [];
    const url = 'https://www.e.leclerc/api/rest/elpev-api/list?filters=%7B%22type%22:%7B%22value%22:%2201%22%7D,%22storePanonceauCode%22:%7B%22value%22:null%7D%7D&page=1&size=20';
    const response = await fetch(url, {
        'referrer': 'https://www.e.leclerc/',
    });
    const jsonobj = await response.json();
    jsonobj.items.map(element => result.push({
        id: element.code,
        title: element.title,
        start: element.startDate, //date de d�but au format ISO
        end: element.endDate //date de fin au format ISO
    }));
    return result;

}

/**
 * Formate la date au format local pour une meilleure pr�sentation
 * @param {any} dateStr - la date, au format YYYY-MM-DD
 * @returns
 */
function formatDate(dateStr) {
    return new Date(Date.parse(dateStr)).toLocaleDateString();
}


/**
 * Laisse l'utilisateur choisir un prospectus dans la liste
 * @param {any} prospectusList liste de prospectus
 * @returns
 */
async function selectProspectus(prospectusList) {
    const prompt = await inquirer.prompt([
        {
            type: 'list',
            name: 'result',
            message: 'Choisir le prospectus:',
            choices: prospectusList.map(prospectus => ({
                name: `${prospectus.title} du ${formatDate(prospectus.start)} au ${formatDate(prospectus.end)}`,
                value: prospectus
            }))
        }
    ]);
    return prompt.result;
}


/**
 * Laisse l'utilisateur s�lectionner le bon magasin
 * @returns 
 */
async function selectStore() {
    //1 : Demande de saisir le code postal pour la requ�te de localisation
    let prompt = await inquirer.prompt([
        {
            type: 'input',
            name: 'postalCode',
            message: 'Code postal:',
        }
    ]);
    const postalCode = prompt.postalCode;
    let url = `https://api.woosmap.com/localities/autocomplete/?input=${postalCode}&key=woos-6256d36f-af9b-3b64-a84f-22b2342121ba&components=country:fr&types=locality|postal_code|admin_level|country|airport|metro_station|train_station&data=advanced&origin=jswidget2.0&no_deprecated_fields=true`;
    let response = await fetch(url, {
        'referrer': 'https://www.e.leclerc/',
    });

    //2 Choisir la localisation en fonction du code postal
    const matchingLocs = await response.json();
    prompt = await inquirer.prompt([
        {
            type: 'list',
            name: 'maplocation',
            message: 'Choisir la localisation :',
            choices: matchingLocs.localities.map(maplocation => ({
                name: `${maplocation.description}`,
                value: maplocation
            }))
        }
    ]);
    const maplocation = prompt.maplocation;

    //3 R�cup�re les coordonn�es GPS de la localisation
    url = `https://api.woosmap.com/localities/details/?key=woos-6256d36f-af9b-3b64-a84f-22b2342121ba&origin=jswidget2.0&public_id=${maplocation.public_id}`;
    response = await fetch(url, {
        'referrer': 'https://www.e.leclerc/',
    });
    let data = await response.json();

    const gpsData = {
        lat: data.result.geometry.location.lat,
        lng: data.result.geometry.location.lng,
    };

    // 4 R�cup�re la liste des magasins proches des coordonn�es GPS et laisse l'utilisateur choisir
    url = `https://api.woosmap.com/stores/search?key=woos-6256d36f-af9b-3b64-a84f-22b2342121ba&lat=${gpsData.lat}&lng=${gpsData.lng}&stores_by_page=5&limit=5&page=1&query=user.type%3A%3D%22pdv%22%20AND%20(user.commercialActivity.activityCode%3A%3D%22101%22%20OR%20user.commercialActivity.activityCode%3A%3D%22102%22)`;
    response = await fetch(url, {
        'referrer': 'https://www.e.leclerc/',
    });
    data = await response.json();
    prompt = await inquirer.prompt([
        {
            type: 'list',
            name: 'store',
            message: 'Choisir le magasin :',
            choices: data.features.map(store => ({
                name: store.properties.name,
                value: store
            }))
        }
    ]);

    return prompt.store;
}


/**
 * R�cup�re la liste des pages (images JPG) du prospectus pour le magasin
 * @param {any} prospectusid - ID du prospectus
 * @param {any} storeId - ID du magasin
 * @returns
 */
async function getProspectusPagesList(prospectusid, storeId) {
    //r�cup�re le UUID du prospectus
    let url = `https://nos-catalogues-promos-v2-api.e.leclerc/${prospectusid}/${storeId}`;
    let response = await fetch(url, {
        'referrer': 'https://nos-catalogues-promos-v2.e.leclerc',
    });
    let jsonobj = await response.json();
    const documentUid = jsonobj.documentUid;

    //r�cup�re la liste des pages
    url = `https://nos-catalogues-promos-v2-api.e.leclerc/document/${documentUid}/pages`;
    response = await fetch(url, {
        'referrer': 'https://nos-catalogues-promos-v2.e.leclerc',
    });

    return await response.json();

}

/**
 * T�l�charge les pages du prospectus (wrapper)
 * @param {any} prospectus - Objet prospectus 
 * @param {any} prospectusPages - liste des pages
 * @returns
 */
async function saveProspectus(prospectus, prospectusPages) {
    const prospectustitle = sanatizePath(prospectus.title);
    const dist = path.resolve('.', prospectustitle);
    const pages = await saveProspectusImages(prospectusPages, dist, (current, imgLen) => {
        console.log(`\r Saved image ${current}/${imgLen}`);
    });
    return pages;
}

/**
 * T�l�charge les pages du prospectus. Renvoie la liste ordonn�e des fichiers t�l�charg�s (chemins locaux sur le disque)
 * @param {any} prospectusPages - liste des pages
 * @param {any} dist - Dossier de destination
 * @param {any} progress - callback indicateur de progression
 * @returns 
 */
async function saveProspectusImages(prospectusPages, dist, progress) {
    let cnt = 0;
    const pages = [];
    await fs.promises.mkdir(dist, { recursive: true });

    for (let i = 0; i < prospectusPages.length; i++) {
        const page = prospectusPages[i];
        const imagePath = path.resolve(dist, `00${page.index}.jpg`);

        if (!fs.existsSync(imagePath)) {
            const bitmap = await downloadImage(page.source);
            saveImage(bitmap, imagePath);
        }
        progress(++cnt, prospectusPages.length);
        pages.push(imagePath);
    }
    return pages;
}

/**
 * T�l�charge le fichier @url et renvoie un buffer
 * @param {any} url - lien du fichier
 * @returns
 */
async function downloadImage(url) {
    let err = null;
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url);
            return res.arrayBuffer();
        } catch (error) {
            err = error;
        }
    }
    throw err;
}

/**
 * Enregistre le buffer @data danbs le fichier @path (pr�alablement sanitis�)
 * @param {any} data
 * @param {any} path
 */
function saveImage(data, path) {
    console.log(`\r\n save to ${path}`);
    fs.writeFileSync(path, new Uint8Array(data));
}


function sanatizePath(path) {
    const platform = os.platform();
    if (platform.indexOf('win') === 0) {
        path = path.replace(/[\\/:*?"<>|\r\n\t]/g, '');
    }
    if (platform.indexOf('linux') === 0) {
        path = path.replace(/[/\r\n\t]/g, '');
    }
    if (platform.indexOf('darwin') === 0) {
        path = path.replace(/[/:\r\n\t]/g, '');
    }
    return path.replace(/[.\s]+$/g, '').trim();
}

//****************************/
//PDF
//************************** */

async function getImageDimensions(page) {
    const data = fs.readFileSync(page);
    const size = calculate(data);
    return size;

}

async function saveChapterPagesPDF(pdfpath, pages, pdfsize) {
    console.log('\r Saving pdf...');
    const require = createRequire(import.meta.url);
    const PDFDocument = require('pdfkit');
   

    const doc = new PDFDocument({ autoFirstPage: false });
    doc.pipe(fs.createWriteStream(pdfpath));
    for (const page of pages) {
        await addImageToPDF(doc, page, pdfsize);
    }
    doc.end();
}

async function addImageToPDF(pdfDocument, page, pdfsize) {
    pdfDocument.addPage({ size: [pdfsize.width, pdfsize.height] });
    pdfDocument.image(page,0,0);
}




