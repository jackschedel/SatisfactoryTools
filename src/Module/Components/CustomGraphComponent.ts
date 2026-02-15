import {IComponentOptions} from 'angular';
import {CustomGraphComponentController} from '@src/Module/Components/CustomGraphComponentController';

export class CustomGraphComponent implements IComponentOptions
{

public template: string = require('@templates/Components/customGraph.html');
public controller = CustomGraphComponentController;
public bindings = {
result: '=',
tabId: '<',
};

}